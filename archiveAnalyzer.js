const fs = require('fs');
const path = require('path');
const { isCopSanityLogPrefix, analyzeSanityLogFile } = require('./analyzer');

const MAX_READ_BYTES = 5 * 1024 * 1024; // cap per-file read to keep grouping fast on huge dumps

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

  const rootEntries = fs.readdirSync(extractRoot, { withFileTypes: true });
  const topLevelDirs = rootEntries.filter((e) => e.isDirectory()).map((e) => e.name);
  const rootFiles = allFiles.filter((f) => !f.relPath.includes(path.sep));

  const tabs = [];

  for (const dirName of topLevelDirs) {
    const dirFiles = allFiles.filter((f) => f.relPath.startsWith(dirName + path.sep));
    const groups = dirFiles.map((file) => analyzeFile(file));
    tabs.push({ name: dirName, fileCount: dirFiles.length, groups });
  }

  // Loose files sitting directly at the archive root (besides the sanity
  // log, which already has its own dedicated view) get their own tab.
  const looseRootFiles = rootFiles.filter((f) => !sanityCandidate || f.fullPath !== sanityCandidate.fullPath);
  if (looseRootFiles.length > 0) {
    const groups = looseRootFiles.map((file) => analyzeFile(file));
    tabs.unshift({ name: 'root', fileCount: looseRootFiles.length, groups });
  }

  return { sanityLogAnalysis, tabs };
}

module.exports = { analyzeExtractedArchive };
