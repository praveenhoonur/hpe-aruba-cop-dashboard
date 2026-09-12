// Shared helpers used by both the Executive Dashboard (exec.js) and the
// Deep-Dive Analysis page (deepdive.js).

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STORAGE_KEY = 'copDashboardPayload';

// Persists the upload result (analysis + archive) so the Deep-Dive page can
// read it after a full page navigation. localStorage (not sessionStorage) is
// used so the link also works if opened in a new tab.
function savePayloadForDeepDive(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...payload, savedAt: Date.now() }));
    return true;
  } catch (err) {
    console.error('Failed to store deep-dive payload:', err);
    return false;
  }
}

function loadPayloadForDeepDive() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Failed to read deep-dive payload:', err);
    return null;
  }
}

const SEVERITY_LABEL = {
  error: 'Likely Root Cause',
  warn: 'Possible Contributing Factor',
  info: 'Info',
};

// ---------------------------------------------------------------------------
// Shared "Cluster Health Analysis" + "Logs Analysis" tab rendering.
// Used by both the Executive Dashboard (inline tabs) and the Deep-Dive page.
// Each caller passes its own chart-instance holder object so charts created
// here can be destroyed/replaced by the calling page without global state
// leaking across pages.
// ---------------------------------------------------------------------------

// Renders the breakdown bar chart + collapsible per-section log details for
// a parsed cop_sanity_logs* file. `chartHolder` is a plain object the caller
// owns; this function stores the created Chart instance at chartHolder.chart
// after destroying any previous one.
function renderSectionsCard(analysis, chartHolder) {
  const container = document.createElement('div');

  if (analysis.summary && analysis.summary.chartData && analysis.summary.chartData.sectionBreakdown) {
    container.appendChild(renderBreakdownChartCard(analysis.summary.chartData.sectionBreakdown, chartHolder));
  }

  const sectionsCard = document.createElement('div');
  sectionsCard.className = 'card';
  sectionsCard.innerHTML = '<h3>Sections</h3>';
  analysis.sections.forEach((section, idx) => {
    const wrapper = document.createElement('details');
    wrapper.className = 'section';
    if (idx === 0) wrapper.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `${escapeHtml(section.title)} <span class="counts">(err:${section.counts.error} warn:${section.counts.warn} info:${section.counts.info})</span>`;
    wrapper.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'section-body';
    if (section.table) {
      body.appendChild(renderKubectlTable(section.table));
    } else {
      section.entries.forEach((entry) => {
        const line = document.createElement('div');
        line.className = `log-line level-${entry.level}`;
        line.textContent = entry.text;
        body.appendChild(line);
      });
    }
    wrapper.appendChild(body);

    sectionsCard.appendChild(wrapper);
  });
  container.appendChild(sectionsCard);

  return container;
}

// Thresholds for coloring percentage-style columns (CPU%, MEMORY%, DISK%
// etc.) so utilization stands out at a glance: green = healthy headroom,
// amber = getting busy, red = near/at capacity.
function percentLevel(value) {
  const num = parseFloat(value);
  if (Number.isNaN(num)) return null;
  if (num >= 85) return 'error';
  if (num >= 60) return 'warn';
  return 'info';
}

// Renders whitespace-column kubectl-style output (e.g. `kubectl top nodes`,
// `kubectl get nodes -o wide`) as a proper HTML table instead of raw text.
// Any column whose header contains "%" gets its cells color-coded by
// utilization so hot nodes/pods are immediately visible.
function renderKubectlTable(table) {
  const wrap = document.createElement('div');
  wrap.className = 'kubectl-table-wrap';

  const el = document.createElement('table');
  el.className = 'kubectl-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  table.headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  el.appendChild(thead);

  const percentCols = table.headers.map((h) => h.includes('%'));

  const tbody = document.createElement('tbody');
  table.rows.forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((cell, i) => {
      const td = document.createElement('td');
      td.textContent = cell;
      if (percentCols[i]) {
        const level = percentLevel(cell);
        if (level) td.classList.add(`level-${level}`, 'kubectl-table-pct');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  el.appendChild(tbody);

  wrap.appendChild(el);
  return wrap;
}

function renderBreakdownChartCard(sectionBreakdown, chartHolder) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<h3>Issue Breakdown by Section</h3>';

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'breakdown-wrap';
  const canvas = document.createElement('canvas');
  canvasWrap.appendChild(canvas);
  card.appendChild(canvasWrap);

  const labels = sectionBreakdown.map((s) => s.title);
  const errorData = sectionBreakdown.map((s) => s.error);
  const warnData = sectionBreakdown.map((s) => s.warn);
  const infoData = sectionBreakdown.map((s) => s.info);

  if (chartHolder && chartHolder.chart) chartHolder.chart.destroy();
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Errors', data: errorData, backgroundColor: '#d93025' },
        { label: 'Warnings', data: warnData, backgroundColor: '#f9ab00' },
        { label: 'Info', data: infoData, backgroundColor: '#188038' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'top' } },
    },
  });
  if (chartHolder) chartHolder.chart = chart;

  return card;
}

// Renders the per-directory tab bar (used for extracted archive contents):
// each archive "tab" becomes a button + panel showing grouped files with
// heuristic RCA and a Jira/Confluence lookup widget per finding.
function renderArchiveTabs(archive) {
  const container = document.createElement('div');

  const tabBar = document.createElement('div');
  tabBar.className = 'tab-bar';

  const panels = document.createElement('div');
  panels.className = 'tab-panels-inner';

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
    panel.appendChild(renderDirectoryTabPanel(tab));
    panels.appendChild(panel);
  });

  container.appendChild(tabBar);
  container.appendChild(panels);
  return container;
}

function renderDirectoryTabPanel(tab) {
  const container = document.createElement('div');

  if (!tab.groups || tab.groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No files found in this directory.';
    container.appendChild(empty);
    return container;
  }

  tab.groups.forEach((file, idx) => {
    const wrapper = document.createElement('details');
    wrapper.className = 'section';
    if (idx === 0) wrapper.open = true;

    const summary = document.createElement('summary');
    const countsLabel = file.counts
      ? `err:${file.counts.error} warn:${file.counts.warn} info:${file.counts.info}`
      : `${file.fileCount} file${file.fileCount === 1 ? '' : 's'}`;
    summary.innerHTML = `<span class="level-${file.status}">${escapeHtml(file.name)}</span> <span class="counts">(${countsLabel})</span>`;
    wrapper.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'section-body group-body';

    if (file.summary) {
      const briefSummary = document.createElement('div');
      briefSummary.className = 'file-summary';
      briefSummary.textContent = file.summary;
      body.appendChild(briefSummary);
    }

    if (file.topPatterns && file.topPatterns.length > 0) {
      const rcaHeading = document.createElement('div');
      rcaHeading.className = 'rca-heading';
      rcaHeading.textContent = 'Analysis & Root Cause';
      body.appendChild(rcaHeading);

      file.topPatterns.forEach((p) => {
        const rcaItem = document.createElement('div');
        rcaItem.className = `rca-item level-${p.severity}`;
        rcaItem.innerHTML = `<strong>${escapeHtml(p.name)}</strong> — ${p.count} occurrence${p.count === 1 ? '' : 's'} · <em>${SEVERITY_LABEL[p.severity] || ''}</em><br/>${escapeHtml(p.rca)}${p.sample ? `<div class="rca-sample">${escapeHtml(p.sample)}</div>` : ''}`;
        rcaItem.appendChild(renderRcaLookupWidget(p.rca));
        body.appendChild(rcaItem);
      });
    } else {
      const ok = document.createElement('div');
      ok.className = 'rca-item level-info';
      ok.textContent = 'No known failure patterns detected in this file — it appears healthy.';
      body.appendChild(ok);
    }

    wrapper.appendChild(body);
    container.appendChild(wrapper);
  });

  return container;
}

// Generic top-level tab widget with two tabs: "Cluster Health Analysis"
// (cop_sanity_logs* section details) and "Logs Analysis" (per-directory
// grouped findings from an extracted archive). Either side may be empty,
// in which case a placeholder message is shown instead.
function renderAnalysisTabsSection(analysis, archive, chartHolder) {
  const section = document.createElement('section');
  section.className = 'analysis-tabs-section';

  const heading = document.createElement('h2');
  heading.className = 'exec-heading';
  heading.textContent = 'Detailed Analysis';
  section.appendChild(heading);

  const tabBar = document.createElement('div');
  tabBar.className = 'tab-bar';

  const panels = document.createElement('div');
  panels.className = 'tab-panels-inner';

  const tabs = [
    { name: 'Cluster Health Analysis' },
    { name: 'Logs Analysis' },
  ];

  tabs.forEach((tab, idx) => {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
    tabBtn.textContent = tab.name;
    tabBtn.addEventListener('click', () => {
      tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      panels.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tabBtn.classList.add('active');
      panel.classList.add('active');
    });
    tabBar.appendChild(tabBtn);

    const panel = document.createElement('div');
    panel.className = `tab-panel${idx === 0 ? ' active' : ''}`;

    if (idx === 0) {
      if (analysis && Array.isArray(analysis.sections) && analysis.sections.length > 0) {
        panel.appendChild(renderSectionsCard(analysis, chartHolder));
      } else {
        const empty = document.createElement('div');
        empty.className = 'card';
        empty.textContent = 'No cop_sanity_logs* file was found in this upload, so no cluster health section details are available.';
        panel.appendChild(empty);
      }
    } else {
      if (archive && Array.isArray(archive.tabs) && archive.tabs.length > 0) {
        panel.appendChild(renderArchiveTabs(archive));
      } else {
        const empty = document.createElement('div');
        empty.className = 'card';
        empty.textContent = 'No directory-based archive contents were extracted for this upload.';
        panel.appendChild(empty);
      }
    }

    panels.appendChild(panel);
  });

  section.appendChild(tabBar);
  section.appendChild(panels);
  return section;
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
