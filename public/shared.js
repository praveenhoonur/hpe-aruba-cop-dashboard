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
