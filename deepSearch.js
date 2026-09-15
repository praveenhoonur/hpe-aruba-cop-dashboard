const fs = require('fs');
const path = require('path');
const readline = require('readline');

// TTL for how long an uploaded file's content stays searchable after
// upload. Deep Search needs the raw/extracted files to still be on disk
// (unlike the rest of the app, which deletes them right after analysis to
// avoid the disk-exhaustion issue fixed earlier), so entries are evicted
// automatically after this window rather than kept forever.
const UPLOAD_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // check for expired entries every 5 min

// Safety caps so a broad/greedy search pattern across many large files
// can't blow up memory or response size — matches are found via streaming
// line-by-line reads (never a full-file readFileSync), and both the total
// number of matches and how much of the file is scanned are bounded.
const MAX_MATCHES = 500;
const MAX_LINE_LENGTH_TO_SCAN = 20000; // skip pathologically long single lines (e.g. minified/binary-ish)
const MAX_FILE_SIZE_TO_SCAN = 200 * 1024 * 1024; // skip files bigger than this

// uploadId -> { label, root, isArchive, uploadedAt, expiresAt }
const registry = new Map();

function registerUpload({ uploadId, label, root, isArchive }) {
  const now = Date.now();
  registry.set(uploadId, {
    label,
    root,
    isArchive,
    uploadedAt: now,
    expiresAt: now + UPLOAD_TTL_MS,
  });
}

function sweepExpired() {
  const now = Date.now();
  for (const [uploadId, entry] of registry.entries()) {
    if (entry.expiresAt <= now) {
      registry.delete(uploadId);
      const target = entry.isArchive ? entry.root : entry.root;
      fs.rm(target, { recursive: true, force: true }, (err) => {
        if (err) console.error(`Deep search cleanup failed for ${uploadId}:`, err);
      });
    }
  }
}

let sweepTimer = null;
function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, SWEEP_INTERVAL_MS);
  sweepTimer.unref(); // don't keep the process alive just for this timer
}

function listActiveUploads() {
  const now = Date.now();
  return Array.from(registry.entries())
    .filter(([, entry]) => entry.expiresAt > now)
    .map(([uploadId, entry]) => ({
      uploadId,
      label: entry.label,
      uploadedAt: entry.uploadedAt,
      expiresInMs: entry.expiresAt - now,
    }))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function walkFiles(dir, base) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return results;
  }
  for (const entry of entries) {
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

// Builds a single-term matcher: tries the term as a regex first (so power
// users can use patterns like "conn.*timeout" inside an AND/OR expression),
// falling back to a literal, case-insensitive substring match if it doesn't
// compile as valid regex.
function buildTermMatcher(term) {
  try {
    const re = new RegExp(term, 'gi');
    return { test: (line) => { re.lastIndex = 0; return re.test(line); } };
  } catch (err) {
    const lower = term.toLowerCase();
    return { test: (line) => line.toLowerCase().includes(lower) };
  }
}

// Strips a single pair of matching double or single quotes wrapping a term,
// so quoted phrases like "connection refused" AND "OOMKilled" can contain
// spaces without being split by the AND/OR tokenizer below.
function unquote(term) {
  const t = term.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Parses a query supporting boolean AND / OR between keywords or regex
// terms, e.g. "error AND timeout", "CrashLoopBackOff OR OOMKilled", or
// "error AND (timeout OR refused)" written without parens as
// "error AND timeout OR error AND refused". OR has lower precedence than
// AND (standard convention), so the query is split into OR-groups first,
// then each group into AND-terms: the line matches if ANY OR-group has ALL
// of its AND-terms present. A query with no AND/OR keywords behaves exactly
// as before (single term, regex-or-literal).
function buildMatcher(query) {
  const orGroups = query
    .split(/\s+OR\s+/i)
    .map((group) => group
      .split(/\s+AND\s+/i)
      .map((term) => unquote(term))
      .filter((term) => term.length > 0)
      .map((term) => buildTermMatcher(term)))
    .filter((andTerms) => andTerms.length > 0);

  if (orGroups.length === 0) {
    // Degenerate query (e.g. just "AND"/"OR" or whitespace) — fall back to
    // matching the raw query as a single term so we never silently match
    // everything or nothing unexpectedly.
    const fallback = buildTermMatcher(query);
    return { test: (line) => fallback.test(line), reset: () => {} };
  }

  return {
    test: (line) => orGroups.some((andTerms) => andTerms.every((m) => m.test(line))),
    reset: () => {},
  };
}

async function searchFile(fullPath, relPath, uploadId, uploadLabel, matcher, matches, lineNumberOffset = 0) {
  return new Promise((resolve) => {
    let lineNumber = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(fullPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      lineNumber += 1;
      if (matches.length >= MAX_MATCHES) {
        rl.close();
        return;
      }
      if (line.length > MAX_LINE_LENGTH_TO_SCAN) return;
      matcher.reset();
      if (matcher.test(line)) {
        matches.push({
          uploadId,
          uploadLabel,
          file: relPath,
          lineNumber,
          line: line.trim().slice(0, 500),
        });
      }
    });

    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

// Searches across every currently-retained upload (within the TTL window)
// for lines matching `query`, returning a flat, chronologically-ordered
// (most recent upload first, then file order, then line order) list of
// matches capped at MAX_MATCHES total.
async function deepSearch(query) {
  const matcher = buildMatcher(query);
  const matches = [];
  const uploads = listActiveUploads();

  for (const upload of uploads) {
    if (matches.length >= MAX_MATCHES) break;
    const entry = registry.get(upload.uploadId);
    if (!entry) continue;

    let files;
    if (entry.isArchive) {
      files = walkFiles(entry.root, entry.root);
    } else {
      files = [{ fullPath: entry.root, relPath: path.basename(entry.root) }];
    }

    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break;
      try {
        const stat = fs.statSync(file.fullPath);
        if (stat.size > MAX_FILE_SIZE_TO_SCAN) continue;
      } catch (err) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await searchFile(file.fullPath, file.relPath, upload.uploadId, entry.label, matcher, matches);
    }
  }

  return {
    matches,
    truncated: matches.length >= MAX_MATCHES,
    uploadsSearched: uploads.length,
  };
}

module.exports = {
  registerUpload,
  listActiveUploads,
  deepSearch,
  startSweeper,
  UPLOAD_TTL_MS,
};
