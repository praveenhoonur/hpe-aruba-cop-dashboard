const root = document.getElementById('deepDiveRoot');
let breakdownChart = null;

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
  if (analysis && Array.isArray(analysis.sections) && analysis.sections.length > 0) {
    const heading = document.createElement('h2');
    heading.className = 'exec-heading';
    heading.textContent = analysis.clusterFqdn
      ? `Health Check of ${analysis.clusterFqdn} Cluster — Deep Dive`
      : `Analysis: ${analysis.fileName}`;
    root.appendChild(heading);

    if (analysis.summary && analysis.summary.chartData) {
      root.appendChild(renderBreakdownChartCard(analysis.summary.chartData.sectionBreakdown));
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
      section.entries.forEach((entry) => {
        const line = document.createElement('div');
        line.className = `log-line level-${entry.level}`;
        line.textContent = entry.text;
        body.appendChild(line);
      });
      wrapper.appendChild(body);

      sectionsCard.appendChild(wrapper);
    });
    root.appendChild(sectionsCard);
  }

  if (archive && Array.isArray(archive.tabs) && archive.tabs.length > 0) {
    root.appendChild(renderArchiveTabs(archive));
  }

  if ((!analysis || !analysis.sections || analysis.sections.length === 0) && (!archive || !archive.tabs || archive.tabs.length === 0)) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.textContent = 'No detailed data available for this upload.';
    root.appendChild(empty);
  }
}

function renderBreakdownChartCard(sectionBreakdown) {
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

  if (breakdownChart) breakdownChart.destroy();
  breakdownChart = new Chart(canvas, {
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

  return card;
}

const SEVERITY_TEXT_LABEL = SEVERITY_LABEL;

function renderArchiveTabs(archive) {
  const container = document.createElement('div');

  const heading = document.createElement('h3');
  heading.textContent = 'Extracted Archive Contents';
  container.appendChild(heading);

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

  container.appendChild(tabBar);
  container.appendChild(panels);
  return container;
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
        rcaItem.innerHTML = `<strong>${escapeHtml(p.name)}</strong> — ${p.count} occurrence${p.count === 1 ? '' : 's'} · <em>${SEVERITY_TEXT_LABEL[p.severity] || ''}</em><br/>${escapeHtml(p.rca)}${p.sample ? `<div class="rca-sample">${escapeHtml(p.sample)}</div>` : ''}`;
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
