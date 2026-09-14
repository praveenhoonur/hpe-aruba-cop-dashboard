const fs = require('fs');
const path = require('path');
const { isCopSanityLogPrefix, analyzeSanityLogFile } = require('./analyzer');

// Cap per-file read to keep both processing time and memory bounded on huge
// dumps. Large sanity-check bundles can contain thousands of pod log files
// totaling multiple GB once extracted; reading each in full (or even at 5MB)
// synchronously in a tight loop was observed to accumulate enough live
// string/array memory to blow past Node's default ~2GB heap limit and crash
// the entire process (killing every other in-flight request, not just the
// large upload) with a generic "Failed to fetch" on the client. 1MB per file
// is still far more than enough to detect the RCA patterns below, which
// typically show up in the first few hundred lines of a log.
const MAX_READ_BYTES = 1 * 1024 * 1024;

// Skip files larger than this entirely (still recorded, just not scanned)
// to avoid wasting time/memory opening thousands of huge binary or rotated
// log files that are unlikely to contain useful, recent RCA signal anyway.
const MAX_FILE_SIZE_TO_SCAN = 200 * 1024 * 1024;

// Ordered set of known failure signatures. For a given group of related
// files we tally how many lines match each pattern; the highest-count
// matches become the "definitive" root-cause hypotheses for that group.
const RCA_PATTERNS = [
  {
    name: 'OOMKilled / Out of Memory',
    re: /\bOOMKilled\b|out of memory/i,
    severity: 'error',
    rca: 'Container(s) were killed for exceeding their memory limit. Likely root cause: memory limit/request set too low for the workload, or a memory leak in the application — review resource limits and profile memory usage.',
  },
  {
    name: 'CrashLoopBackOff',
    re: /CrashLoopBackOff/i,
    severity: 'error',
    rca: 'Container is repeatedly crashing on startup. Likely root cause: application failing during initialization (bad config, missing dependency, or unhandled exception) — inspect the container logs for the exact stack trace/exit code.',
  },
  {
    name: 'ImagePullBackOff / ErrImagePull',
    re: /ImagePullBackOff|ErrImagePull/i,
    severity: 'error',
    rca: 'Kubernetes could not pull the container image. Likely root cause: incorrect image name/tag, missing registry credentials, or no network access to the registry — verify the image reference and imagePullSecrets.',
  },
  {
    name: 'Liveness/Readiness Probe Failure',
    re: /(liveness|readiness) probe failed/i,
    severity: 'warn',
    rca: 'Health probe(s) are failing. Likely root cause: the application is not responding on the probe endpoint within the configured timeout — check the probe path/port, increase the timeout, or verify app startup time.',
  },
  {
    name: 'Connection Refused / Timeout',
    re: /connection refused|i\/o timeout|dial tcp.*timeout/i,
    severity: 'warn',
    rca: 'Network calls between components are failing. Likely root cause: the target service/pod is unreachable — check service DNS, network policies, or the availability of the downstream dependency.',
  },
  {
    name: 'Permission / Auth Failure',
    re: /permission denied|forbidden|unauthorized/i,
    severity: 'error',
    rca: 'Access was denied. Likely root cause: incorrect RBAC role bindings, file/volume permissions, or expired credentials — review the service account roles and mounted secrets.',
  },
  {
    name: 'Disk Pressure / No Space',
    re: /no space left on device|disk[- ]?pressure/i,
    severity: 'error',
    rca: 'Node or container storage is exhausted. Likely root cause: insufficient disk capacity or unbounded log/data growth — check node disk usage and log rotation policies.',
  },
  {
    name: 'DNS Resolution Failure',
    re: /could not resolve host|no such host|dns.*(fail|error)/i,
    severity: 'error',
    rca: 'DNS resolution is failing for a dependency. Likely root cause: CoreDNS/cluster DNS issue or an incorrect service name — verify cluster DNS health and the referenced hostname.',
  },
  {
    name: 'Generic Error',
    re: /\berror\b/i,
    severity: 'error',
    rca: 'Multiple generic error lines were found. Manual log review is recommended to pinpoint the exact failure.',
  },
];

function walkFiles(dir, base) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip macOS AppleDouble metadata (._foo) and other OS-generated noise
    // files that aren't part of the actual log bundle.
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      results.push({ fullPath: full, relPath: path.relative(base, full) });
    }
  }
  return results;
}

function readTextSafe(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_FILE_SIZE_TO_SCAN) return '';
    const fd = fs.openSync(fullPath, 'r');
    const size = Math.min(stat.size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch (err) {
    return '';
  }
}

function analyzeFile(file) {
  const patternCounts = RCA_PATTERNS.map((p) => ({ pattern: p, count: 0, sample: null }));
  const levelCounts = { error: 0, warn: 0, info: 0 };
  let totalLines = 0;

  const text = readTextSafe(file.fullPath);
  const lines = text ? text.split(/\r?\n/) : [];
  for (const line of lines) {
    if (!line.trim()) continue;
    totalLines += 1;
    for (const entry of patternCounts) {
      if (entry.pattern.re.test(line)) {
        entry.count += 1;
        if (!entry.sample) entry.sample = line.trim().slice(0, 300);
      }
    }
    if (/\b(error|crashloopbackoff|imagepullbackoff|fail(ed)?)\b/i.test(line)) levelCounts.error += 1;
    else if (/\b(warn(ing)?|unhealthy|deprecat(ed|ion))\b/i.test(line)) levelCounts.warn += 1;
    else levelCounts.info += 1;
  }

  const topPatterns = patternCounts
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((e) => ({
      name: e.pattern.name,
      severity: e.pattern.severity,
      count: e.count,
      sample: e.sample,
      rca: e.pattern.rca,
    }));

  let status = 'info';
  if (topPatterns.some((p) => p.severity === 'error')) status = 'error';
  else if (topPatterns.some((p) => p.severity === 'warn')) status = 'warn';

  const summary = totalLines === 0
    ? 'File is empty or unreadable — nothing to analyze.'
    : status === 'info'
      ? `Scanned ${totalLines} line${totalLines === 1 ? '' : 's'} — no known failure patterns detected; file appears healthy.`
      : `Scanned ${totalLines} line${totalLines === 1 ? '' : 's'} — found ${topPatterns.length} notable issue${topPatterns.length === 1 ? '' : 's'} (${levelCounts.error} error-like, ${levelCounts.warn} warning-like line${levelCounts.warn === 1 ? '' : 's'}).`;

  return {
    name: path.basename(file.relPath),
    fileCount: 1,
    files: [file.relPath],
    totalLines,
    counts: levelCounts,
    summary,
    status,
    topPatterns,
  };
}

// Walks the extracted archive, finds a cop_sanity_logs* file (if any) for the
// existing cluster-health page, and builds per-directory "tabs" where each
// file gets its own collapsible entry with a brief summary and heuristic RCA.
//
// Tabs are built by grouping files by their *immediate parent directory*,
// found anywhere in the archive at any nesting depth (not just directly
// under the extract root). This means an archive shaped like:
//   coplogs-20260904-193130/
//     cop_sanity_logs-20260904-193130.log        (handled separately above)
//     lspodnr/            <- becomes its own tab
//     lspod_cop_upgrade_tools/  <- becomes its own tab
//     lspod_ivt/          <- becomes its own tab
// produces one "Logs Analysis" sub-tab per leaf directory (lspodnr,
// lspod_cop_upgrade_tools, lspod_ivt), regardless of how many wrapper
// folders the archive tool added around them.
function analyzeExtractedArchive(extractRoot) {
  const allFiles = walkFiles(extractRoot, extractRoot);

  let sanityLogAnalysis = null;
  const sanityCandidate = allFiles.find((f) => isCopSanityLogPrefix(path.basename(f.relPath)));
  if (sanityCandidate) {
    try {
      sanityLogAnalysis = analyzeSanityLogFile(sanityCandidate.fullPath, path.basename(sanityCandidate.relPath));
    } catch (err) {
      console.error('Failed to analyze embedded sanity log:', err);
    }
  }

  // The sanity log already has its own dedicated Cluster Health view, so
  // exclude it from the per-directory tabs to avoid showing it twice.
  const filesForTabs = allFiles.filter((f) => !sanityCandidate || f.fullPath !== sanityCandidate.fullPath);

  const dirGroups = new Map(); // key: relative directory path ('.' = extract root), value: file[]
  for (const file of filesForTabs) {
    const dirRel = path.dirname(file.relPath);
    if (!dirGroups.has(dirRel)) dirGroups.set(dirRel, []);
    dirGroups.get(dirRel).push(file);
  }

  // Disambiguate directories that share the same basename (e.g. two
  // different parents both containing a "logs" folder) by falling back to
  // the full relative path for just those colliding names.
  const nameCounts = new Map();
  for (const dirRel of dirGroups.keys()) {
    const base = dirRel === '.' ? 'root' : path.basename(dirRel);
    nameCounts.set(base, (nameCounts.get(base) || 0) + 1);
  }

  const tabs = [];
  for (const [dirRel, files] of dirGroups.entries()) {
    const base = dirRel === '.' ? 'root' : path.basename(dirRel);
    const name = nameCounts.get(base) > 1 && dirRel !== '.' ? dirRel.split(path.sep).join(' / ') : base;
    const groups = files.map((file) => analyzeFile(file));
    tabs.push({ name, fileCount: files.length, groups });
  }

  // Keep "root" (loose files directly at the archive root) first, then sort
  // the rest alphabetically for a stable, predictable tab order.
  tabs.sort((a, b) => {
    if (a.name === 'root') return -1;
    if (b.name === 'root') return 1;
    return a.name.localeCompare(b.name);
  });

  return { sanityLogAnalysis, tabs };
}

module.exports = { analyzeExtractedArchive };

