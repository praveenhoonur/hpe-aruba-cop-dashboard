const form = document.getElementById('uploadForm');
const statusEl = document.getElementById('status');
const execSummaryEl = document.getElementById('execSummary');
const analysisTabsEl = document.getElementById('analysisTabs');
const resetBtn = document.getElementById('resetBtn');
const ALLOWED = ['.log', '.txt', '.tar', '.tar.zip', '.tar.gz', '.zip', '.gz'];

let gaugeChart = null;
let podChart = null;
const breakdownChartHolder = {};

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
    statusEl.textContent = 'Unsupported file type. Allowed: .log, .txt, .tar, .tar.zip, .tar.gz, .zip';
    statusEl.classList.add('error');
    return;
  }

  const formData = new FormData();
  formData.append('logfile', file);

  execSummaryEl.innerHTML = '';

  try {
    const data = await uploadWithProgress(formData);

    if (data.success) {
      statusEl.textContent = data.message;
      statusEl.classList.add('success');
      form.reset();
      renderExecSummary(data.analysis, data.archive);
    } else {
      statusEl.textContent = data.message || 'Upload failed.';
      statusEl.classList.add('error');
    }
  } catch (err) {
    statusEl.textContent = `Upload failed: ${err.message}`;
    statusEl.classList.add('error');
  }
});

// Uploads via XMLHttpRequest instead of fetch so we can (a) report real
// upload progress for large files over slow/VPN links, where a silent,
// progress-less "Uploading..." message for 1-2+ minutes gets mistaken for a
// hang/failure, and (b) surface a specific reason when the request truly
// fails (network drop vs. an explicit non-2xx response) instead of the
// generic, unhelpful "Failed to fetch" message fetch() throws for any
// network-level error.
function uploadWithProgress(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.timeout = 0; // no client-side timeout; large uploads can take minutes

    xhr.upload.addEventListener('progress', (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.round((evt.loaded / evt.total) * 100);
        const mbLoaded = (evt.loaded / (1024 * 1024)).toFixed(1);
        const mbTotal = (evt.total / (1024 * 1024)).toFixed(1);
        statusEl.textContent = `Uploading... ${pct}% (${mbLoaded} MB / ${mbTotal} MB)`;
        statusEl.className = 'status';
      }
    });

    xhr.addEventListener('load', () => {
      statusEl.textContent = 'Processing upload...';
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (parseErr) {
        reject(new Error(`server returned an invalid response (HTTP ${xhr.status})`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        resolve(data);
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('network error during upload (connection lost/reset). If this happens on large files, check for a VPN, proxy, or firewall timeout between your browser and the server.'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('upload was aborted.'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new Error('upload timed out.'));
    });

    statusEl.textContent = 'Uploading... 0%';
    statusEl.className = 'status';
    xhr.send(formData);
  });
}

// Clears the selected file, status message, rendered exec summary, and any
// charts/state from a previous upload so the page returns to its initial state.
resetBtn.addEventListener('click', () => {
  form.reset();
  statusEl.textContent = '';
  statusEl.className = 'status';
  execSummaryEl.innerHTML = '';
  analysisTabsEl.innerHTML = '';
  // Reset previously wiped the Deep Search tab along with the exec summary
  // and never rendered it back, silently breaking search until a full page
  // reload. Deep Search isn't tied to the current upload (it searches
  // whatever's still within the server-side retention window), so restore
  // the tab bar immediately, same as the initial page-load render.
  analysisTabsEl.appendChild(renderAnalysisTabsSection(null, null, breakdownChartHolder));
  if (gaugeChart) {
    gaugeChart.destroy();
    gaugeChart = null;
  }
  if (podChart) {
    podChart.destroy();
    podChart = null;
  }
  if (breakdownChartHolder.chart) {
    breakdownChartHolder.chart.destroy();
    breakdownChartHolder.chart = null;
  }
});

const OVERALL_STATUS_LABEL = {
  error: 'Critical Issues Detected',
  warn: 'Warnings Detected',
  info: 'Healthy',
};const STATUS_COLOR = {
  error: '#d93025',
  warn: '#f9ab00',
  info: '#188038',
};

function computeHealthScore(chartData) {
  const parts = [];
  if (chartData.nodesTotal) parts.push({ pct: (chartData.nodesReady / chartData.nodesTotal) * 100, weight: 0.3 });
  if (chartData.componentsTotal) parts.push({ pct: (chartData.componentsHealthy / chartData.componentsTotal) * 100, weight: 0.3 });
  if (chartData.podsTotal) parts.push({ pct: (chartData.podsRunning / chartData.podsTotal) * 100, weight: 0.4 });

  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = parts.reduce((s, p) => s + p.pct * p.weight, 0) / totalWeight;
  return Math.round(score);
}

function renderExecSummary(analysis, archive) {
  execSummaryEl.innerHTML = '';
  analysisTabsEl.innerHTML = '';

  if (!analysis || !analysis.summary) {
    if (archive && Array.isArray(archive.tabs) && archive.tabs.length > 0) {
      const notice = document.createElement('div');
      notice.className = 'card';
      notice.innerHTML = `<p>No cluster health summary file (<code>cop_sanity_logs*</code>) was found in the uploaded archive, but its contents were extracted.</p>`;
      execSummaryEl.appendChild(notice);
      analysisTabsEl.appendChild(renderAnalysisTabsSection(analysis, archive, breakdownChartHolder));
    }
    return;
  }

  const { summary, clusterFqdn } = analysis;
  const healthScore = computeHealthScore(summary.chartData || {});

  const heading = document.createElement('h2');
  heading.className = 'exec-heading';
  heading.textContent = clusterFqdn ? `Health Check of ${clusterFqdn} Cluster` : `Analysis: ${analysis.fileName}`;
  execSummaryEl.appendChild(heading);

  // Top verdict banner
  const verdict = document.createElement('div');
  verdict.className = `verdict-banner status-${summary.status}`;
  verdict.innerHTML = `<span class="verdict-badge">${OVERALL_STATUS_LABEL[summary.status] || 'Unknown'}</span> ${escapeHtml(verdictSentence(summary))}`;
  execSummaryEl.appendChild(verdict);

  // KPI tiles + gauge + donut row
  const grid = document.createElement('div');
  grid.className = 'exec-grid';

  grid.appendChild(renderGaugeCard(healthScore, summary.status));
  grid.appendChild(renderKpiTiles(summary));
  const podCard = renderPodDonutCard(summary.chartData || {});
  if (podCard) grid.appendChild(podCard);

  execSummaryEl.appendChild(grid);

  // Top risks callout
  const risks = (summary.metrics || []).filter((m) => m.level === 'error' || m.level === 'warn').slice(0, 3);
  if (risks.length > 0) {
    const risksCard = document.createElement('div');
    risksCard.className = 'card risks-card';
    risksCard.innerHTML = '<h3>Top Risks</h3>';
    const list = document.createElement('ul');
    risks.forEach((m) => {
      const li = document.createElement('li');
      li.className = `level-${m.level}`;
      li.innerHTML = `<strong>${escapeHtml(m.label)}:</strong> ${escapeHtml(m.value)}`;
      list.appendChild(li);
    });
    risksCard.appendChild(list);
    execSummaryEl.appendChild(risksCard);
  }

  // AI Executive Briefing (Copilot narrative)
  execSummaryEl.appendChild(renderCopilotBriefing(analysis));

  // Inline tabbed section: Cluster Health Analysis + Logs Analysis
  analysisTabsEl.appendChild(renderAnalysisTabsSection(analysis, archive, breakdownChartHolder));
}

function verdictSentence(summary) {
  const { totals } = summary;
  if (summary.status === 'error') {
    return `${totals.error} error${totals.error === 1 ? '' : 's'} detected across the health check — immediate attention recommended.`;
  }
  if (summary.status === 'warn') {
    return `${totals.warn} warning${totals.warn === 1 ? '' : 's'} detected — no critical failures, but worth reviewing.`;
  }
  return 'No errors or warnings detected. Cluster is operating normally.';
}

function renderGaugeCard(healthScore, status) {
  const card = document.createElement('div');
  card.className = 'card gauge-card';
  card.innerHTML = '<h3>Cluster Health Score</h3>';

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'gauge-wrap';
  const canvas = document.createElement('canvas');
  canvasWrap.appendChild(canvas);

  const scoreLabel = document.createElement('div');
  scoreLabel.className = `gauge-score status-${status}`;
  scoreLabel.textContent = healthScore === null ? 'N/A' : `${healthScore}%`;
  canvasWrap.appendChild(scoreLabel);

  card.appendChild(canvasWrap);

  const value = healthScore === null ? 0 : healthScore;
  const color = STATUS_COLOR[status] || STATUS_COLOR.info;

  if (gaugeChart) gaugeChart.destroy();
  gaugeChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [
        {
          data: [value, 100 - value],
          backgroundColor: [color, '#e8eaed'],
          borderWidth: 0,
        },
      ],
    },
    options: {
      circumference: 180,
      rotation: 270,
      cutout: '75%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 600 },
    },
  });

  return card;
}

function renderKpiTiles(summary) {
  const card = document.createElement('div');
  card.className = 'card kpi-card';
  card.innerHTML = '<h3>Key Metrics</h3>';

  const grid = document.createElement('div');
  grid.className = 'kpi-tiles';

  const tiles = [
    { label: 'Errors', value: summary.totals.error, level: summary.totals.error > 0 ? 'error' : 'info' },
    { label: 'Warnings', value: summary.totals.warn, level: summary.totals.warn > 0 ? 'warn' : 'info' },
    { label: 'Info Signals', value: summary.totals.info, level: 'info' },
  ];

  tiles.forEach((t) => {
    const tile = document.createElement('div');
    tile.className = `kpi-tile level-${t.level}`;
    tile.innerHTML = `<div class="kpi-value">${t.value}</div><div class="kpi-label">${escapeHtml(t.label)}</div>`;
    grid.appendChild(tile);
  });

  card.appendChild(grid);
  return card;
}

function renderPodDonutCard(chartData) {
  if (!chartData.podsTotal) return null;

  const card = document.createElement('div');
  card.className = 'card donut-card';
  card.innerHTML = '<h3>Pod Status</h3>';

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'donut-wrap';
  const canvas = document.createElement('canvas');
  canvasWrap.appendChild(canvas);
  card.appendChild(canvasWrap);

  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  legend.innerHTML = `<span class="legend-dot" style="background:#188038"></span> Running: ${chartData.podsRunning}
    &nbsp;&nbsp;<span class="legend-dot" style="background:#d93025"></span> Not Running: ${chartData.podsNotRunning}`;
  card.appendChild(legend);

  if (podChart) podChart.destroy();
  podChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Running', 'Not Running'],
      datasets: [
        {
          data: [chartData.podsRunning, chartData.podsNotRunning],
          backgroundColor: ['#188038', '#d93025'],
          borderWidth: 0,
        },
      ],
    },
    options: {
      cutout: '65%',
      plugins: { legend: { display: false } },
      animation: { duration: 600 },
    },
  });

  return card;
}

// Opt-in AI narrative aimed at an executive audience: sends the already-parsed
// analysis to the server, which asks the headless Copilot CLI to produce a
// natural-language briefing. Only triggered on user click since it can take
// up to ~1-2 minutes.
function renderCopilotBriefing(analysis) {
  const wrapper = document.createElement('div');
  wrapper.className = 'card copilot-narrative';
  wrapper.innerHTML = '<h3>AI Executive Briefing</h3>';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn copilot-btn';
  button.textContent = '✨ Get AI Executive Briefing';
  wrapper.appendChild(button);

  const output = document.createElement('div');
  output.className = 'copilot-output';
  wrapper.appendChild(output);

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Generating briefing... (this can take up to a minute)';
    output.textContent = '';
    output.classList.remove('copilot-error');

    try {
      const res = await fetch('/api/copilot-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis }),
      });
      const data = await res.json();
      if (data.success) {
        output.innerHTML = `<p>${escapeHtml(data.narrative).replace(/\n/g, '<br>')}</p>`;
        button.textContent = '✨ Regenerate Briefing';
      } else {
        output.classList.add('copilot-error');
        output.textContent = `Briefing failed: ${data.message}`;
        button.textContent = '✨ Get AI Executive Briefing';
      }
    } catch (err) {
      output.classList.add('copilot-error');
      output.textContent = `Briefing failed: ${err.message}`;
      button.textContent = '✨ Get AI Executive Briefing';
    } finally {
      button.disabled = false;
    }
  });

  return wrapper;
}

// Deep Search needs to work across recently uploaded files even if the
// user hasn't uploaded anything in the current page load (or refreshed the
// page after uploading), so render the tab bar (Cluster Health / Logs
// Analysis / Deep Search) immediately on load rather than waiting for a
// successful upload. Cluster Health / Logs Analysis simply show their
// existing "no data yet" placeholders until an upload happens on this page.
analysisTabsEl.appendChild(renderAnalysisTabsSection(null, null, breakdownChartHolder));
