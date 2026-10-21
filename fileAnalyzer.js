const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { detectLevel } = require('./analyzer');

// Analyzes any uploaded file that is NOT a cop_sanity_logs* file and NOT an
// archive (.tar/.tar.gz/.tar.zip/.zip): generic .log/.txt, .har, .csv, and
// legacy .xls uploads. Each gets a lightweight, type-specific summary
// rendered in the "File Analysis" tab on the client, distinct from the
// cop_sanity-specific "Cluster Health Analysis" section parsing in
// analyzer.js.

// Caps mirror the defense-in-depth read limits used elsewhere (analyzer.js,
// archiveAnalyzer.js) so an unexpectedly huge upload can't exhaust the
// process heap or blow up response size.
const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_LOG_LINES_SCANNED = 20000;
const MAX_LOG_ENTRIES_RETURNED = 2000;
const MAX_CSV_ROWS_RETURNED = 2000;
const MAX_XLS_ROWS_RETURNED = 2000;
const MAX_HAR_TABLE_ROWS = 500;

function readCapped(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_TEXT_FILE_BYTES) {
    return fs.readFileSync(filePath, 'utf8');
  }
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(MAX_TEXT_FILE_BYTES);
  fs.readSync(fd, buffer, 0, MAX_TEXT_FILE_BYTES, 0);
  fs.closeSync(fd);
  return buffer.toString('utf8');
}

// ---------------------------------------------------------------------------
// Generic .log / .txt (anything that isn't a cop_sanity_logs* file)
// ---------------------------------------------------------------------------

// Normalizes a log line so near-identical errors (differing only by
// timestamp/IP/UUID/numeric IDs) collapse into one recurring "signature"
// instead of flooding the list with hundreds of near-duplicates.
function normalizeSignature(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<TS>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<IP>')
    .replace(/\b\d+\b/g, '<N>')
    .trim();
}

function analyzeGenericLog(content, originalName) {
  try {
    const allLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (allLines.length === 0) {
      return { kind: 'error', fileName: originalName, message: `Parser error: "${originalName}" appears to be empty.` };
    }
    const scanned = allLines.slice(0, MAX_LOG_LINES_SCANNED);
    const entries = scanned.map((text) => ({ text, level: detectLevel(text) }));

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

    const sigMap = new Map();
    entries
      .filter((e) => e.level === 'error' || e.level === 'warn')
      .forEach((e) => {
        const pattern = normalizeSignature(e.text);
        const existing = sigMap.get(pattern);
        if (existing) existing.count += 1;
        else sigMap.set(pattern, { pattern, sample: e.text, level: e.level, count: 1 });
      });
    const topSignatures = Array.from(sigMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return {
      kind: 'genericLog',
      fileName: originalName,
      totalLines: allLines.length,
      linesScanned: scanned.length,
      truncated: allLines.length > MAX_LOG_LINES_SCANNED,
      counts,
      status,
      topSignatures,
      entries: entries.slice(0, MAX_LOG_ENTRIES_RETURNED),
      entriesTruncated: entries.length > MAX_LOG_ENTRIES_RETURNED,
    };
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Parser error: unable to parse "${originalName}" as text (${err.message}). It may be a binary file rather than plain text.` };
  }
}

// ---------------------------------------------------------------------------
// .har (HTTP Archive — JSON)
// ---------------------------------------------------------------------------

// Default thresholds for the API-level analysis below (overridable by caller).
const DEFAULT_SLOW_THRESHOLD_MS = 2000;
const DEFAULT_TIMEOUT_THRESHOLD_MS = 10000;
const MAX_API_LIST_SIZE = 20;
const MAX_API_STATUS_LIST_SIZE = 10;

// Parses raw HAR JSON text into a flat array of per-request rows
// ({ method, url, domain, status, time, mimeType }), or returns
// { error: <string> } if the content isn't valid/well-formed HAR. Shared by
// both a direct .har upload (analyzeHar below) and the archive scanner
// (archiveAnalyzer.js), which may find one or more .har files inside an
// extracted log bundle.
function parseHarEntries(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { error: `is not valid JSON (${err.message})` };
  }

  if (!parsed || !parsed.log || !Array.isArray(parsed.log.entries)) {
    return { error: 'does not look like a valid HAR file — expected a top-level "log.entries" array' };
  }

  const rows = parsed.log.entries.map((e) => {
    const status = e.response ? Number(e.response.status) || 0 : 0;
    let domain = '';
    try {
      domain = new URL(e.request ? e.request.url : '').hostname;
    } catch (_err) {
      domain = '';
    }
    return {
      method: e.request ? e.request.method : '',
      url: e.request ? e.request.url : '',
      domain,
      status,
      time: typeof e.time === 'number' ? e.time : 0,
      mimeType: e.response && e.response.content ? e.response.content.mimeType || '' : '',
    };
  });

  return { rows };
}

// Groups HAR request rows by exact "METHOD URL" (including query string) and
// builds the API-level breakdowns: top-consumed endpoints, slow/stressed
// endpoints, endpoints hitting timeouts, and top endpoints per HTTP status
// bucket. Used both for a single .har upload and for an archive containing
// one or more .har files (rows from all of them are merged first).
function buildApiAnalysis(rows, opts = {}) {
  const slowThresholdMs = opts.slowThresholdMs || DEFAULT_SLOW_THRESHOLD_MS;
  const timeoutThresholdMs = opts.timeoutThresholdMs || DEFAULT_TIMEOUT_THRESHOLD_MS;

  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.method} ${row.url}`;
    if (!groups.has(key)) {
      groups.set(key, {
        method: row.method,
        url: row.url,
        count: 0,
        totalTime: 0,
        maxTime: 0,
        minTime: Infinity,
        buckets: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 },
        timeoutCount: 0,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.totalTime += row.time;
    g.maxTime = Math.max(g.maxTime, row.time);
    g.minTime = Math.min(g.minTime, row.time);
    const bucket = row.status >= 200 && row.status < 300 ? '2xx'
      : row.status >= 300 && row.status < 400 ? '3xx'
        : row.status >= 400 && row.status < 500 ? '4xx'
          : row.status >= 500 && row.status < 600 ? '5xx'
            : 'other';
    g.buckets[bucket] += 1;
    // A request with no response at all (status 0) or one that took at/above
    // the timeout threshold is counted as a timeout for that endpoint.
    if (row.status === 0 || row.time >= timeoutThresholdMs) g.timeoutCount += 1;
  });

  const list = Array.from(groups.values()).map((g) => ({
    method: g.method,
    url: g.url,
    count: g.count,
    avgTime: g.totalTime / g.count,
    maxTime: g.maxTime,
    minTime: g.minTime === Infinity ? 0 : g.minTime,
    buckets: g.buckets,
    timeoutCount: g.timeoutCount,
  }));

  const topApis = [...list].sort((a, b) => b.count - a.count).slice(0, MAX_API_LIST_SIZE);

  // "Slow or stressed" = endpoints whose average or peak latency crosses the
  // slow threshold; ranked by (avg time * call count) so an endpoint that's
  // both frequently called AND slow — i.e. genuinely "stressed" — floats to
  // the top rather than a one-off slow outlier.
  const slowApis = list
    .filter((a) => a.avgTime >= slowThresholdMs || a.maxTime >= slowThresholdMs)
    .sort((a, b) => (b.avgTime * b.count) - (a.avgTime * a.count))
    .slice(0, MAX_API_LIST_SIZE);

  const timeoutApis = list
    .filter((a) => a.timeoutCount > 0)
    .sort((a, b) => b.timeoutCount - a.timeoutCount)
    .slice(0, MAX_API_LIST_SIZE);

  const top5xx = list.filter((a) => a.buckets['5xx'] > 0).sort((a, b) => b.buckets['5xx'] - a.buckets['5xx']).slice(0, MAX_API_STATUS_LIST_SIZE);
  const top4xx = list.filter((a) => a.buckets['4xx'] > 0).sort((a, b) => b.buckets['4xx'] - a.buckets['4xx']).slice(0, MAX_API_STATUS_LIST_SIZE);
  const top3xx = list.filter((a) => a.buckets['3xx'] > 0).sort((a, b) => b.buckets['3xx'] - a.buckets['3xx']).slice(0, MAX_API_STATUS_LIST_SIZE);

  return {
    totalApis: list.length,
    slowThresholdMs,
    timeoutThresholdMs,
    topApis,
    slowApis,
    timeoutApis,
    top5xx,
    top4xx,
    top3xx,
  };
}

function analyzeHar(content, originalName) {
  const parsedResult = parseHarEntries(content);
  if (parsedResult.error) {
    return { kind: 'error', fileName: originalName, message: `Parser error: "${originalName}" ${parsedResult.error}. A .har file must be a valid HTTP Archive export.` };
  }

  const rows = parsedResult.rows;
  const statusBuckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  rows.forEach((r) => {
    const bucket = r.status >= 200 && r.status < 300 ? '2xx'
      : r.status >= 300 && r.status < 400 ? '3xx'
        : r.status >= 400 && r.status < 500 ? '4xx'
          : r.status >= 500 && r.status < 600 ? '5xx'
            : 'other';
    statusBuckets[bucket] += 1;
  });

  const failed = rows.filter((r) => r.status >= 400);
  const slowest = [...rows].sort((a, b) => b.time - a.time).slice(0, 15);

  const domainCounts = rows.reduce((acc, r) => {
    if (r.domain) acc[r.domain] = (acc[r.domain] || 0) + 1;
    return acc;
  }, {});
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  const toTableRows = (list) => list.map((r) => [r.method, String(r.status), r.domain, String(Math.round(r.time)), r.mimeType, r.url]);
  const headers = ['Method', 'Status', 'Domain', 'Time (ms)', 'Type', 'URL'];

  return {
    kind: 'har',
    fileName: originalName,
    totalRequests: rows.length,
    statusBuckets,
    topDomains,
    failedCount: failed.length,
    status: failed.length > 0 ? 'error' : 'info',
    table: { headers, rows: toTableRows(rows.slice(0, MAX_HAR_TABLE_ROWS)) },
    failedTable: { headers, rows: toTableRows(failed.slice(0, MAX_HAR_TABLE_ROWS)) },
    slowestTable: { headers, rows: toTableRows(slowest) },
    apiAnalysis: buildApiAnalysis(rows),
  };
}

// ---------------------------------------------------------------------------
// .csv
// ---------------------------------------------------------------------------

// Minimal RFC-4180-ish CSV line parser: handles quoted fields (including
// embedded commas and escaped "" quotes) without pulling in a dependency.
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function analyzeCsv(content, originalName) {
  try {
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) {
      return { kind: 'csv', fileName: originalName, empty: true, status: 'neutral' };
    }

    const headers = parseCsvLine(lines[0]).map((h) => h.trim());
    if (headers.length === 0 || headers.every((h) => h === '')) {
      return { kind: 'error', fileName: originalName, message: `Parser error: could not read a header row from "${originalName}". Make sure the file is comma-separated with a header on the first line.` };
    }
    const dataLines = lines.slice(1);
    const truncated = dataLines.length > MAX_CSV_ROWS_RETURNED;
    const rows = dataLines.slice(0, MAX_CSV_ROWS_RETURNED).map(parseCsvLine);

    const colStats = headers
      .map((h, idx) => {
        const values = rows.map((r) => parseFloat(r[idx])).filter((v) => !Number.isNaN(v));
        if (values.length === 0) return null;
        const sum = values.reduce((a, b) => a + b, 0);
        return { header: h, min: Math.min(...values), max: Math.max(...values), avg: sum / values.length, count: values.length };
      })
      .filter(Boolean);

    let status = 'info';
    const statusColIdx = headers.findIndex((h) => /^(status|level)$/i.test(h.trim()));
    if (statusColIdx >= 0) {
      const hasError = rows.some((r) => /error|fail|critical/i.test(r[statusColIdx] || ''));
      const hasWarn = rows.some((r) => /warn/i.test(r[statusColIdx] || ''));
      if (hasError) status = 'error';
      else if (hasWarn) status = 'warn';
    }

    return {
      kind: 'csv',
      fileName: originalName,
      totalRows: dataLines.length,
      truncated,
      status,
      colStats,
      table: { headers, rows },
    };
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Parser error: unable to parse "${originalName}" as CSV (${err.message}).` };
  }
}

// ---------------------------------------------------------------------------
// .xls (legacy binary Excel workbook, via SheetJS)
// ---------------------------------------------------------------------------

function analyzeXls(filePath, originalName) {
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Parser error: unable to read "${originalName}" as an Excel workbook (${err.message}). It may be corrupted, password-protected, or not a real .xls/.xlsx file.` };
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { kind: 'error', fileName: originalName, message: `Parser error: "${originalName}" does not contain any sheets.` };
  }

  try {
    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      if (json.length === 0) return { name, headers: [], rows: [], totalRows: 0, truncated: false };

      const headers = (json[0] || []).map((h) => String(h));
      const dataRows = json.slice(1);
      const truncated = dataRows.length > MAX_XLS_ROWS_RETURNED;
      const rows = dataRows
        .slice(0, MAX_XLS_ROWS_RETURNED)
        .map((r) => headers.map((_, i) => (r[i] !== undefined ? String(r[i]) : '')));

      return { name, headers, rows, totalRows: dataRows.length, truncated };
    });

    return { kind: 'xls', fileName: originalName, status: 'info', sheets };
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Parser error: unable to read sheet data from "${originalName}" (${err.message}).` };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function analyzeMiscFile(filePath, originalName) {
  const lower = originalName.toLowerCase();
  try {
    if (lower.endsWith('.har')) return analyzeHar(readCapped(filePath), originalName);
    if (lower.endsWith('.csv')) return analyzeCsv(readCapped(filePath), originalName);
    if (lower.endsWith('.xls')) return analyzeXls(filePath, originalName);
    if (lower.endsWith('.log') || lower.endsWith('.txt')) return analyzeGenericLog(readCapped(filePath), originalName);
    // Files with no recognized extension (including no extension at all,
    // e.g. "messages", "syslog") are treated as plain text/log content.
    if (path.extname(lower) === '') return analyzeGenericLog(readCapped(filePath), originalName);
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Parser error: unable to read or parse "${originalName}" (${err.message}).` };
  }
  return null;
}

module.exports = { analyzeMiscFile, parseHarEntries, buildApiAnalysis };
