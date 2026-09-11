const root = document.getElementById('deepDiveRoot');
const chartHolder = {};

const payload = loadPayloadForDeepDive();

if (!payload || (!payload.analysis && !payload.archive)) {
  root.innerHTML = `
    <div class="card">
      <p>No analysis data found. Please upload a file from the Executive Dashboard first.</p>
      <a class="btn btn-primary" href="index.html">Go to Executive Dashboard</a>
    </div>
  `;
} else {
  renderDeepDive(payload.analysis, payload.archive);
}

function renderDeepDive(analysis, archive) {
  const heading = document.createElement('h2');
  heading.className = 'exec-heading';
  heading.textContent = analysis && analysis.clusterFqdn
    ? `Health Check of ${analysis.clusterFqdn} Cluster — Deep Dive`
    : analysis && analysis.fileName
      ? `Analysis: ${analysis.fileName}`
      : 'Deep-Dive Analysis';
  root.appendChild(heading);

  const hasSections = analysis && Array.isArray(analysis.sections) && analysis.sections.length > 0;
  const hasArchive = archive && Array.isArray(archive.tabs) && archive.tabs.length > 0;

  if (!hasSections && !hasArchive) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.textContent = 'No detailed data available for this upload.';
    root.appendChild(empty);
    return;
  }

  root.appendChild(renderAnalysisTabsSection(analysis, archive, chartHolder));
}
