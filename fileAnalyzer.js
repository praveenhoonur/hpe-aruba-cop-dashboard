const fs = require('fs');
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
  const allLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
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
}

// ---------------------------------------------------------------------------
// .har (HTTP Archive — JSON)
// ---------------------------------------------------------------------------

function analyzeHar(content, originalName) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Invalid HAR/JSON file: ${err.message}` };
  }

  const rawEntries = parsed && parsed.log && Array.isArray(parsed.log.entries) ? parsed.log.entries : [];
  const statusBuckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };

  const rows = rawEntries.map((e) => {
    const status = e.response ? Number(e.response.status) || 0 : 0;
    const bucket = status >= 200 && status < 300 ? '2xx'
      : status >= 300 && status < 400 ? '3xx'
        : status >= 400 && status < 500 ? '4xx'
          : status >= 500 && status < 600 ? '5xx'
            : 'other';
    statusBuckets[bucket] += 1;

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
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { kind: 'csv', fileName: originalName, empty: true, status: 'neutral' };
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
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
}

// ---------------------------------------------------------------------------
// .xls (legacy binary Excel workbook, via SheetJS)
// ---------------------------------------------------------------------------

function analyzeXls(filePath, originalName) {
  const workbook = XLSX.readFile(filePath);
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
  } catch (err) {
    return { kind: 'error', fileName: originalName, message: `Failed to analyze file: ${err.message}` };
  }
  return null;
}

module.exports = { analyzeMiscFile };
