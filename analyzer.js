const fs = require('fs');

// Matches filenames like: cop_sanity_logs-20260904-193130.log
const COP_SANITY_PATTERN = /^cop_sanity_logs-\d{8}-\d{6}\.log$/i;

function isCopSanityLog(originalName) {
  return COP_SANITY_PATTERN.test(originalName);
}

// The sanity script wraps each category in a banner like:
//   ===============================================================
//   STEP: <category name>
//   ===============================================================
//   <content...>
const DELIMITER_RE = /^=+$/;
const STEP_RE = /^STEP:\s*(.+)$/i;

function detectLevel(line) {
  if (/\b(error|crashloopbackoff|imagepullbackoff|fail(ed)?)\b/i.test(line)) return 'error';
  if (/\b(warn(ing)?|unhealthy|deprecat(ed|ion))\b/i.test(line)) return 'warn';
  if (/\b(healthy|ready|running|completed|\bok\b)\b/i.test(line)) return 'info';
  return 'neutral';
}

// Kubectl (and similar) CLI output is often a whitespace-column-aligned
// table: a header row followed by data rows using 2+ spaces as the column
// separator (single spaces are preserved so values like "Ubuntu 22.04 LTS"
// stay intact). When a section's lines fit this shape consistently (every
// row has the same column count as the header), we surface it as a proper
// table instead of a wall of raw text; on any inconsistency we bail out and
// let the section fall back to plain line-by-line rendering.
function tryParseTable(entries) {
  if (entries.length < 2) return null;
  const headerLine = entries[0].text.trim();
  if (!/\s{2,}/.test(headerLine)) return null;

  const headers = headerLine.split(/\s{2,}/).map((h) => h.trim()).filter(Boolean);
  if (headers.length < 2) return null;

  const rows = [];
  for (let i = 1; i < entries.length; i += 1) {
    const raw = entries[i].text.trim();
    if (!raw) continue;
    const cols = raw.split(/\s{2,}/).map((c) => c.trim());
    if (cols.length !== headers.length) return null;
    rows.push(cols);
  }
  if (rows.length === 0) return null;

  return { headers, rows };
}

// Converts a `du -h`-style human size ("246M", "19G", "4.0K") to bytes
// (binary/1024-based, matching coreutils' -h output) for sorting/scaling.
function parseHumanSize(str) {
  const m = str.trim().match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return null;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
  return num * mult;
}

// The per-node "/mnt/*" disk usage step runs `du -h` on each cluster node
// and prints a hostname line followed by that node's "<size>\t/mnt/<name>"
// mount usage lines (any SSH connectivity errors are interspersed and
// ignored). This turns that flat, repetitive text block into a
// { nodes: [{ host, mounts: [{ size, path, bytes }] }] } structure so the UI
// can show one collapsible per node with mounts sorted by size, biggest
// first.
function tryParseDiskUsageByNode(entries) {
  const mountLineRe = /^(\S+)\s+(\/mnt\/\S+)$/;
  const nodes = [];
  let current = null;
  let matchedAny = false;

  for (const entry of entries) {
    const line = entry.text.trim();
    if (!line) continue;

    const mountMatch = line.match(mountLineRe);
    if (mountMatch) {
      matchedAny = true;
      if (!current) {
        current = { host: 'unknown host', mounts: [] };
        nodes.push(current);
      }
      current.mounts.push({ size: mountMatch[1], path: mountMatch[2], bytes: parseHumanSize(mountMatch[1]) });
      continue;
    }

    // A bare hostname-looking line (no spaces, not an SSH error message)
    // starts a new node's mount list.
    if (!line.includes(' ') && !/^ssh:/i.test(line)) {
      current = { host: line, mounts: [] };
      nodes.push(current);
    }
  }

  if (!matchedAny) return null;
  const nonEmpty = nodes.filter((n) => n.mounts.length > 0);
  if (nonEmpty.length === 0) return null;

  nonEmpty.forEach((n) => {
    n.mounts.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    n.totalBytes = n.mounts.reduce((sum, m) => sum + (m.bytes || 0), 0);
  });

  return { nodes: nonEmpty };
}

function parseSections(content) {
  const lines = content.split(/\r?\n/);
  const sections = [];
  let current = { title: 'Session Info', lines: [] };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, '');

    // Detect a "===...=== / STEP: <name> / ===...===" banner
    if (DELIMITER_RE.test(line.trim()) && lines[i + 1]) {
      const stepMatch = lines[i + 1].trim().match(STEP_RE);
      if (stepMatch && lines[i + 2] && DELIMITER_RE.test(lines[i + 2].trim())) {
        if (current.lines.some((l) => l.trim().length > 0)) {
          sections.push(current);
        }
        current = { title: stepMatch[1].trim(), lines: [] };
        i += 2; // skip the STEP line and the closing delimiter line
        continue;
      }
    }

    current.lines.push(line);
  }

  if (current.lines.some((l) => l.trim().length > 0)) {
    sections.push(current);
  }

  return sections.map((section) => {
    const entries = section.lines
      .filter((l) => l.trim().length > 0)
      .map((l) => ({ text: l, level: detectLevel(l) }));

    const counts = entries.reduce(
      (acc, e) => {
        acc[e.level] = (acc[e.level] || 0) + 1;
        return acc;
      },
      { error: 0, warn: 0, info: 0, neutral: 0 }
    );

    let status = 'info';
    if (counts.error > 0) status = 'error';
    else if (counts.warn > 0) status = 'warn';
    else if (counts.info === 0) status = 'neutral';

    const diskUsage = /disk usage/i.test(section.title) ? tryParseDiskUsageByNode(entries) : null;
    const table = diskUsage ? null : tryParseTable(entries);

    return { title: section.title, status, counts, entries, table, diskUsage };
  });
}

function findSection(sections, titleSubstr) {
  const needle = titleSubstr.toLowerCase();
  return sections.find((s) => s.title.toLowerCase().includes(needle));
}

function extractFirst(content, regex) {
  const m = content.match(regex);
  return m ? m[1].trim() : null;
}

// Builds a high-level "cluster health" overview from the parsed sections,
// pulling out a handful of concrete signals (node readiness, component
// health, pod counts, restart hot-spots) in addition to the aggregate
// error/warn/info tally across all sections.
function buildSummary(sections, content) {
  const totals = sections.reduce(
    (acc, s) => {
      acc.error += s.counts.error;
      acc.warn += s.counts.warn;
      acc.info += s.counts.info;
      return acc;
    },
    { error: 0, warn: 0, info: 0 }
  );

  const metrics = [];
  // Raw numeric fields for chart rendering (health gauge, pod donut, etc.)
  // kept separate from the human-readable `metrics` list below.
  const chartData = {
    nodesReady: null,
    nodesTotal: null,
    componentsHealthy: null,
    componentsTotal: null,
    podsTotal: null,
    podsRunning: null,
    podsNotRunning: null,
    kubeWarningEvents: null,
    topRestartCount: null,
    sectionBreakdown: sections.map((s) => ({
      title: s.title,
      error: s.counts.error,
      warn: s.counts.warn,
      info: s.counts.info,
    })),
  };

  const copVersion = extractFirst(content, /COP Version:\s*(.+)/i);
  const copHostVersion = extractFirst(content, /COP Host Software Version:\s*(.+)/i);
  if (copVersion) {
    metrics.push({
      label: 'COP Version',
      value: copHostVersion ? `${copVersion} (host ${copHostVersion})` : copVersion,
      level: 'info',
    });
  }

  const declaredNodeCount = extractFirst(content, /Cluster Node Count\s*:\s*(\d+)/i);
  const nodeSection = findSection(sections, 'get nodes -o wide');
  if (nodeSection) {
    const nodeRows = nodeSection.entries.filter((e) => /^\S+\s+(Ready|NotReady)\b/.test(e.text));
    const readyCount = nodeRows.filter((e) => /^\S+\s+Ready\b/.test(e.text)).length;
    const totalNodes = Number(declaredNodeCount) || nodeRows.length;
    chartData.nodesReady = readyCount;
    chartData.nodesTotal = totalNodes;
    metrics.push({
      label: 'Cluster Nodes Ready',
      value: `${readyCount}/${totalNodes}`,
      level: readyCount < nodeRows.length ? 'error' : 'info',
    });
  }

  const componentSection = findSection(sections, 'componentstatuses');
  if (componentSection) {
    const rows = componentSection.entries.filter((e) => /^\S+\s+(Healthy|Unhealthy)\b/i.test(e.text));
    const unhealthy = rows.filter((e) => !/^\S+\s+Healthy\b/i.test(e.text));
    chartData.componentsHealthy = rows.length - unhealthy.length;
    chartData.componentsTotal = rows.length;
    metrics.push({
      label: 'Control Plane Components',
      value: unhealthy.length === 0 ? `All Healthy (${rows.length})` : `${unhealthy.length}/${rows.length} Unhealthy`,
      level: unhealthy.length === 0 ? 'info' : 'error',
    });
  }

  const podCountSection = findSection(sections, 'podcount');
  if (podCountSection) {
    const text = podCountSection.entries.map((e) => e.text).join('\n');
    const total = extractFirst(text, /Total:\s*(\d+)/i);
    const running = extractFirst(text, /Running:\s*(\d+)/i);
    const notRunning = extractFirst(text, /Not Running:\s*(\d+)/i);
    if (total) {
      chartData.podsTotal = Number(total);
      chartData.podsRunning = Number(running) || 0;
      chartData.podsNotRunning = Number(notRunning) || 0;
      metrics.push({
        label: 'Pods Running',
        value: `${running || 0}/${total} (${notRunning || 0} not running)`,
        level: Number(notRunning) > 0 ? 'warn' : 'info',
      });
    }
  }

  const kubeSystemSection = findSection(sections, 'kube-system');
  if (kubeSystemSection) {
    const warningEvents = kubeSystemSection.entries.filter((e) => /\bWarning\b/.test(e.text)).length;
    chartData.kubeWarningEvents = warningEvents;
    metrics.push({
      label: 'kube-system Warning Events',
      value: String(warningEvents),
      level: warningEvents > 0 ? 'warn' : 'info',
    });
  }

  const restartSection = findSection(sections, 'restartcount');
  if (restartSection && restartSection.entries.length > 0) {
    const topLine = restartSection.entries[0].text;
    const restartMatch = topLine.match(/(\d+)\s*\([^)]*ago\)/);
    const cols = topLine.trim().split(/\s{2,}/);
    if (restartMatch) chartData.topRestartCount = Number(restartMatch[1]);
    metrics.push({
      label: 'Highest Restart Count',
      value: restartMatch ? `${cols[1] || cols[0]} - ${restartMatch[1]} restarts` : topLine.trim(),
      level: restartMatch && Number(restartMatch[1]) > 0 ? 'warn' : 'info',
    });
  }

  let overallStatus = 'info';
  if (totals.error > 0) overallStatus = 'error';
  else if (totals.warn > 0) overallStatus = 'warn';

  return { status: overallStatus, totals, metrics, chartData };
}

function analyzeContent(content, originalName) {
  const sections = parseSections(content);
  const summary = buildSummary(sections, content);
  const clusterFqdn = extractFirst(content, /Cluster FQDN\s*:\s*(\S+)/i);
  return { fileName: originalName, clusterFqdn, summary, sections };
}

// Cap how much of a sanity log we read into memory as a defense-in-depth
// measure — legitimate cop_sanity_logs files are typically a few hundred KB,
// but an unexpectedly huge one (e.g. a mis-tagged/corrupted upload) should
// not be able to exhaust the process heap. 50MB is far more than any real
// sanity log needs while still being generous.
const MAX_SANITY_LOG_BYTES = 50 * 1024 * 1024;

function readSanityLogContent(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_SANITY_LOG_BYTES) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(MAX_SANITY_LOG_BYTES);
  fs.readSync(fd, buffer, 0, MAX_SANITY_LOG_BYTES, 0);
  fs.closeSync(fd);
  return buffer.toString('utf8');
}

function analyzeLogFile(filePath, originalName) {
  if (!isCopSanityLog(originalName)) return null;
  const content = readSanityLogContent(filePath);
  return analyzeContent(content, originalName);
}

// Used when scanning inside an extracted archive: any file whose *name*
// starts with "cop_sanity_logs" (regardless of exact timestamp/extension)
// should be analyzed the same way as a direct .log upload.
const COP_SANITY_PREFIX_RE = /^cop_sanity_logs/i;

function isCopSanityLogPrefix(fileName) {
  return COP_SANITY_PREFIX_RE.test(fileName);
}

function analyzeSanityLogFile(filePath, originalName) {
  const content = readSanityLogContent(filePath);
  return analyzeContent(content, originalName);
}

module.exports = {
  isCopSanityLog,
  isCopSanityLogPrefix,
  analyzeLogFile,
  analyzeSanityLogFile,
};
