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

    return { title: section.title, status, counts, entries };
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
    metrics.push({
      label: 'Cluster Nodes Ready',
      value: `${readyCount}/${declaredNodeCount || nodeRows.length}`,
      level: readyCount < nodeRows.length ? 'error' : 'info',
    });
  }

  const componentSection = findSection(sections, 'componentstatuses');
  if (componentSection) {
    const rows = componentSection.entries.filter((e) => /^\S+\s+(Healthy|Unhealthy)\b/i.test(e.text));
    const unhealthy = rows.filter((e) => !/^\S+\s+Healthy\b/i.test(e.text));
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
    metrics.push({
      label: 'Highest Restart Count',
      value: restartMatch ? `${cols[1] || cols[0]} - ${restartMatch[1]} restarts` : topLine.trim(),
      level: restartMatch && Number(restartMatch[1]) > 0 ? 'warn' : 'info',
    });
  }

  let overallStatus = 'info';
  if (totals.error > 0) overallStatus = 'error';
  else if (totals.warn > 0) overallStatus = 'warn';

  return { status: overallStatus, totals, metrics };
}

function analyzeContent(content, originalName) {
  const sections = parseSections(content);
  const summary = buildSummary(sections, content);
  const clusterFqdn = extractFirst(content, /Cluster FQDN\s*:\s*(\S+)/i);
  return { fileName: originalName, clusterFqdn, summary, sections };
}

function analyzeLogFile(filePath, originalName) {
  if (!isCopSanityLog(originalName)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
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
  const content = fs.readFileSync(filePath, 'utf8');
  return analyzeContent(content, originalName);
}

module.exports = {
  isCopSanityLog,
  isCopSanityLogPrefix,
  analyzeLogFile,
  analyzeSanityLogFile,
};
