require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { analyzeLogFile } = require('./analyzer');
const { extractArchive, isArchiveFile } = require('./archiveExtractor');
const { analyzeExtractedArchive } = require('./archiveAnalyzer');
const { generateCopilotNarrative } = require('./copilotNarrator');
const { lookupRelatedIssues } = require('./rcaLookup');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_EXT = ['.log', '.txt', '.tar', '.zip'];
const ALLOWED_COMPOUND_SUFFIXES = ['.tar.zip', '.tar.gz'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${timestamp}-${safeName}`);
  },
});

function fileFilter(req, file, cb) {
  const name = file.originalname.toLowerCase();
  // Support compound extensions (.tar.zip, .tar.gz) in addition to single extensions above
  const isCompound = ALLOWED_COMPOUND_SUFFIXES.some((suffix) => name.endsWith(suffix));
  const ext = path.extname(name);
  if (isCompound || ALLOWED_EXT.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: .log, .txt, .tar, .tar.zip, .tar.gz, .zip'));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

app.post('/upload', (req, res) => {
  upload.single('logfile')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    let analysis = null;
    let archive = null;

    try {
      if (isArchiveFile(req.file.originalname)) {
        const extractRoot = path.join(uploadDir, 'extracted', path.basename(req.file.path));
        await extractArchive(req.file.path, req.file.originalname, extractRoot);
        const { sanityLogAnalysis, tabs } = analyzeExtractedArchive(extractRoot);
        analysis = sanityLogAnalysis;
        archive = { tabs };
      } else {
        analysis = analyzeLogFile(req.file.path, req.file.originalname);
      }
    } catch (parseErr) {
      console.error('Analysis failed:', parseErr);
    }

    res.json({
      success: true,
      message: `File "${req.file.originalname}" uploaded successfully.`,
      analysis,
      archive,
    });
  });
});

// Opt-in endpoint: takes the already-parsed analysis (summary + sections)
// produced by /upload and asks the headless Copilot CLI to turn it into a
// natural-language narrative + likely root cause. Kept separate from
// /upload because it's slower (can take up to ~1-2 min) and consumes AI
// credits, so the user explicitly triggers it.
app.post('/api/copilot-narrative', async (req, res) => {
  const { analysis } = req.body || {};
  if (!analysis || typeof analysis !== 'object') {
    return res.status(400).json({ success: false, message: 'Missing analysis payload.' });
  }

  try {
    const narrative = await generateCopilotNarrative(analysis);
    res.json({ success: true, narrative });
  } catch (err) {
    console.error('Copilot narrative failed:', err);
    res.status(502).json({ success: false, message: err.message });
  }
});

// Takes RCA text (either a Copilot narrative or one of the heuristic RCA
// entries from archive analysis), extracts a tight search query from its
// "Likely Root Cause" section, and looks up similar issues/playbooks in
// on-prem Jira and Confluence in parallel. Each source fails independently
// so a partial result (e.g. Confluence unreachable) still returns Jira hits.
app.post('/api/rca-lookup', async (req, res) => {
  const { rcaText } = req.body || {};
  if (!rcaText || typeof rcaText !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing rcaText payload.' });
  }

  try {
    const result = await lookupRelatedIssues(rcaText);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('RCA lookup failed:', err);
    res.status(502).json({ success: false, message: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`HPE Aruba COP Dashboard running at http://localhost:${PORT}`);
});

// Node's http server enforces a default 5-minute limit (requestTimeout) on
// how long it will wait to receive a full request, plus a 60s headersTimeout
// for just the header phase. Large uploads (100MB+) over slower/VPN links
// can easily take longer than 5 minutes to transfer, which was silently
// destroying the socket mid-upload and surfacing to the browser as a
// generic "Failed to fetch" with no server-side error logged. Disable both
// so large-file uploads aren't cut off; per-file size is still bounded by
// multer's fileSize limit above.
server.requestTimeout = 0;
server.headersTimeout = 0;

