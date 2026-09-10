const fs = require('fs');
const tar = require('tar');
const AdmZip = require('adm-zip');

// Extracts a .tar, .tar.gz (or .tgz), or .tar.zip/.zip archive into destDir.
// node-tar auto-detects gzip compression from the file's magic bytes, so a
// single tar.x() call handles both .tar and .tar.gz/.tgz.
async function extractArchive(filePath, originalName, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const lowerName = originalName.toLowerCase();

  if (lowerName.endsWith('.tar') || lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tgz')) {
    await tar.x({ file: filePath, cwd: destDir });
    return destDir;
  }

  if (lowerName.endsWith('.tar.zip') || lowerName.endsWith('.zip')) {
    try {
      const zip = new AdmZip(filePath);
      zip.extractAllTo(destDir, true);
    } catch (zipErr) {
      // Some ".tar.zip" files are really just a tar stream with a misleading
      // suffix — fall back to tar extraction before giving up.
      await tar.x({ file: filePath, cwd: destDir });
    }
    return destDir;
  }

  throw new Error(`Unsupported archive type for extraction: ${originalName}`);
}

function isArchiveFile(originalName) {
  const lowerName = originalName.toLowerCase();
  return (
    lowerName.endsWith('.tar') ||
    lowerName.endsWith('.tar.gz') ||
    lowerName.endsWith('.tgz') ||
    lowerName.endsWith('.tar.zip') ||
    lowerName.endsWith('.zip')
  );
}

module.exports = { extractArchive, isArchiveFile };
