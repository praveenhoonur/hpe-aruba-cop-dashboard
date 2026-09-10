const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { analyzeLogFile } = require('./analyzer');
const { extractArchive, isArchiveFile } = require('./archiveExtractor');
const { analyzeExtractedArchive } = require('./archiveAnalyzer');

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_EXT = ['.log', '.txt', '.tar'];
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
    cb(new Error('Unsupported file type. Allowed: .log, .txt, .tar, .tar.zip, .tar.gz'));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(PORT, () => {
  console.log(`HPE Aruba COP Dashboard running at http://localhost:${PORT}`);
});
