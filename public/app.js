const form = document.getElementById('uploadForm');
const statusEl = document.getElementById('status');
const analysisEl = document.getElementById('analysis');
const ALLOWED = ['.log', '.txt', '.tar', '.tar.zip', '.tar.gz', '.zip', '.gz'];

function hasAllowedExtension(name) {
  const lower = name.toLowerCase();
  return ALLOWED.some((ext) => lower.endsWith(ext));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  statusEl.className = 'status';

  const fileInput = document.getElementById('logfile');
  const file = fileInput.files[0];

  if (!file) {
    statusEl.textContent = 'Please choose a file first.';
    statusEl.classList.add('error');
    return;
  }

  if (!hasAllowedExtension(file.name)) {
    statusEl.textContent = 'Unsupported file type. Allowed: .log, .txt, .tar, .tar.zip, .tar.gz';
    statusEl.classList.add('error');
    return;
  }

  const formData = new FormData();
  formData.append('logfile', file);

  statusEl.textContent = 'Uploading...';
  analysisEl.innerHTML = '';

  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (res.ok && data.success) {
      statusEl.textContent = data.message;
      statusEl.classList.add('success');
      form.reset();
      renderAnalysis(data.analysis);
    } else {
      statusEl.textContent = data.message || 'Upload failed.';
      statusEl.classList.add('error');
    }
  } catch (err) {
    statusEl.textContent = `Upload failed: ${err.message}`;
    statusEl.classList.add('error');
  }
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderAnalysis(analysis) {
  analysisEl.innerHTML = '';
  if (!analysis || !Array.isArray(analysis.sections) || analysis.sections.length === 0) {
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = analysis.clusterFqdn
    ? `Health Check of ${analysis.clusterFqdn} Cluster`
    : `Analysis: ${analysis.fileName}`;
  analysisEl.appendChild(heading);

  if (analysis.summary) {
    analysisEl.appendChild(renderSummary(analysis.summary));
  }

  analysis.sections.forEach((section, idx) => {
    const wrapper = document.createElement('details');
    wrapper.className = 'section';
    if (idx === 0) wrapper.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `${escapeHtml(section.title)} <span class="counts">(err:${section.counts.error} warn:${section.counts.warn} info:${section.counts.info})</span>`;
    wrapper.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'section-body';
    section.entries.forEach((entry) => {
      const line = document.createElement('div');
      line.className = `log-line level-${entry.level}`;
      line.textContent = entry.text;
      body.appendChild(line);
    });
    wrapper.appendChild(body);

    analysisEl.appendChild(wrapper);
  });
}

const OVERALL_STATUS_LABEL = {
  error: 'Critical Issues Detected',
  warn: 'Warnings Detected',
  info: 'Healthy',
};

function renderSummary(summary) {
  const wrapper = document.createElement('div');
  wrapper.className = `summary-card status-${summary.status}`;

  const title = document.createElement('h4');
  title.className = 'summary-title';
  title.textContent = `Overall Cluster Health: ${OVERALL_STATUS_LABEL[summary.status] || 'Unknown'}`;
  wrapper.appendChild(title);

  const totalsLine = document.createElement('div');
  totalsLine.className = 'summary-totals';
  totalsLine.textContent = `Across all sections — Errors: ${summary.totals.error}, Warnings: ${summary.totals.warn}, Info: ${summary.totals.info}`;
  wrapper.appendChild(totalsLine);

  if (Array.isArray(summary.metrics) && summary.metrics.length > 0) {
    const list = document.createElement('ul');
    list.className = 'summary-metrics';
    summary.metrics.forEach((metric) => {
      const item = document.createElement('li');
      item.className = `level-${metric.level}`;
      item.innerHTML = `<span class="metric-label">${escapeHtml(metric.label)}:</span> <span class="metric-value">${escapeHtml(metric.value)}</span>`;
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  }

  return wrapper;
}

