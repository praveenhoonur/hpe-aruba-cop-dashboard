const form = document.getElementById('uploadForm');
const statusEl = document.getElementById('status');
const analysisEl = document.getElementById('analysis');
const archiveTabsEl = document.getElementById('archiveTabs');
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
  archiveTabsEl.innerHTML = '';

  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (res.ok && data.success) {
      statusEl.textContent = data.message;
      statusEl.classList.add('success');
      form.reset();
      renderAnalysis(data.analysis);
      renderArchiveTabs(data.archive);
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
    analysisEl.appendChild(renderCopilotNarrativeSection(analysis));
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

// Opt-in AI narrative: sends the already-parsed analysis to the server, which
// asks the headless Copilot CLI to produce a natural-language summary + RCA.
// Only triggered on user click since it can take up to ~1-2 minutes.
function renderCopilotNarrativeSection(analysis) {
  const wrapper = document.createElement('div');
  wrapper.className = 'copilot-narrative';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copilot-btn';
  button.textContent = '✨ Analyze with Copilot';
  wrapper.appendChild(button);

  const output = document.createElement('div');
  output.className = 'copilot-output';
  wrapper.appendChild(output);

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Analyzing... (this can take up to a minute)';
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
        output.innerHTML = `<h5>Copilot Analysis</h5><p>${escapeHtml(data.narrative).replace(/\n/g, '<br>')}</p>`;
        output.appendChild(renderRcaLookupWidget(data.narrative));
        button.textContent = '✨ Re-analyze with Copilot';
      } else {
        output.classList.add('copilot-error');
        output.textContent = `Copilot analysis failed: ${data.message}`;
        button.textContent = '✨ Analyze with Copilot';
      }
    } catch (err) {
      output.classList.add('copilot-error');
      output.textContent = `Copilot analysis failed: ${err.message}`;
      button.textContent = '✨ Analyze with Copilot';
    } finally {
      button.disabled = false;
    }
  });

  return wrapper;
}

// Shared widget: given RCA text (Copilot narrative or a heuristic RCA entry),
// lets the user trigger a parallel Jira + Confluence search for related
// issues/playbooks using a tight query extracted server-side from the
// "Likely Root Cause" section.
function renderRcaLookupWidget(rcaText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'rca-lookup';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rca-lookup-btn';
  button.textContent = '🔎 Find Related Jira/Confluence Issues';
  wrapper.appendChild(button);

  const output = document.createElement('div');
  output.className = 'rca-lookup-output';
  wrapper.appendChild(output);

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Searching Jira & Confluence...';
    output.innerHTML = '';

    try {
      const res = await fetch('/api/rca-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rcaText }),
      });
      const data = await res.json();
      if (!data.success) {
        output.innerHTML = `<div class="rca-lookup-error">Lookup failed: ${escapeHtml(data.message)}</div>`;
      } else {
        output.appendChild(renderRcaLookupResults(data));
      }
    } catch (err) {
      output.innerHTML = `<div class="rca-lookup-error">Lookup failed: ${escapeHtml(err.message)}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = '🔎 Search Again';
    }
  });

  return wrapper;
}

function renderRcaLookupResults(data) {
  const container = document.createElement('div');

  const queryLine = document.createElement('div');
  queryLine.className = 'rca-lookup-query';
  queryLine.textContent = `Search query: "${data.query}"`;
  container.appendChild(queryLine);

  const cols = document.createElement('div');
  cols.className = 'rca-lookup-columns';

  cols.appendChild(renderRcaLookupColumn('Jira', data.jira, data.errors?.jira, (item) =>
    `<a href="${item.url}" target="_blank" rel="noopener"><strong>${escapeHtml(item.key)}</strong></a> ${escapeHtml(item.summary)}<br><span class="rca-lookup-meta">${escapeHtml(item.status)}${item.priority ? ` · ${escapeHtml(item.priority)}` : ''}</span>`
  ));

  cols.appendChild(renderRcaLookupColumn('Confluence', data.confluence, data.errors?.confluence, (item) =>
    `<a href="${item.url}" target="_blank" rel="noopener"><strong>${escapeHtml(item.title)}</strong></a>${item.space ? `<br><span class="rca-lookup-meta">${escapeHtml(item.space)}</span>` : ''}`
  ));

  container.appendChild(cols);
  return container;
}

function renderRcaLookupColumn(label, items, error, renderItem) {
  const col = document.createElement('div');
  col.className = 'rca-lookup-col';

  const heading = document.createElement('h6');
  heading.textContent = label;
  col.appendChild(heading);

  if (error) {
    const err = document.createElement('div');
    err.className = 'rca-lookup-error';
    err.textContent = error;
    col.appendChild(err);
    return col;
  }

  if (!items || items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No related results found.';
    col.appendChild(empty);
    return col;
  }

  const list = document.createElement('ul');
  items.forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = renderItem(item);
    list.appendChild(li);
  });
  col.appendChild(list);
  return col;
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

const SEVERITY_LABEL = {
  error: 'Likely Root Cause',
  warn: 'Possible Contributing Factor',
  info: 'Info',
};

function renderArchiveTabs(archive) {
  archiveTabsEl.innerHTML = '';
  if (!archive || !Array.isArray(archive.tabs) || archive.tabs.length === 0) {
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = 'Extracted Archive Contents';
  archiveTabsEl.appendChild(heading);

  const tabBar = document.createElement('div');
  tabBar.className = 'tab-bar';

  const panels = document.createElement('div');
  panels.className = 'tab-panels';

  archive.tabs.forEach((tab, idx) => {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
    tabBtn.textContent = `${tab.name} (${tab.fileCount})`;
    tabBtn.addEventListener('click', () => {
      tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      panels.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tabBtn.classList.add('active');
      panel.classList.add('active');
    });
    tabBar.appendChild(tabBtn);

    const panel = document.createElement('div');
    panel.className = `tab-panel${idx === 0 ? ' active' : ''}`;
    panel.appendChild(renderTabPanel(tab));
    panels.appendChild(panel);
  });

  archiveTabsEl.appendChild(tabBar);
  archiveTabsEl.appendChild(panels);
}

function renderTabPanel(tab) {
  const container = document.createElement('div');

  if (!tab.groups || tab.groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No files found in this directory.';
    container.appendChild(empty);
    return container;
  }

  tab.groups.forEach((group, idx) => {
    const wrapper = document.createElement('details');
    wrapper.className = 'section';
    if (idx === 0) wrapper.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `${escapeHtml(group.name)} <span class="counts">(${group.fileCount} file${group.fileCount === 1 ? '' : 's'})</span>`;
    wrapper.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'section-body group-body';

    const fileList = document.createElement('div');
    fileList.className = 'group-files';
    fileList.textContent = `Files: ${group.files.join(', ')}`;
    body.appendChild(fileList);

    if (group.topPatterns && group.topPatterns.length > 0) {
      const rcaHeading = document.createElement('div');
      rcaHeading.className = 'rca-heading';
      rcaHeading.textContent = 'Analysis & Root Cause';
      body.appendChild(rcaHeading);

      group.topPatterns.forEach((p) => {
        const rcaItem = document.createElement('div');
        rcaItem.className = `rca-item level-${p.severity}`;
        rcaItem.innerHTML = `<strong>${escapeHtml(p.name)}</strong> — ${p.count} occurrence${p.count === 1 ? '' : 's'} · <em>${SEVERITY_LABEL[p.severity] || ''}</em><br/>${escapeHtml(p.rca)}${p.sample ? `<div class="rca-sample">${escapeHtml(p.sample)}</div>` : ''}`;
        rcaItem.appendChild(renderRcaLookupWidget(p.rca));
        body.appendChild(rcaItem);
      });
    } else {
      const ok = document.createElement('div');
      ok.className = 'rca-item level-info';
      ok.textContent = 'No known failure patterns detected in this group — files appear healthy.';
      body.appendChild(ok);
    }

    wrapper.appendChild(body);
    container.appendChild(wrapper);
  });

  return container;
}

