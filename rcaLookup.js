const https = require('https');
const http = require('http');
const { URL } = require('url');

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const CONFLUENCE_BASE_URL = (process.env.CONFLUENCE_BASE_URL || '').replace(/\/+$/, '');
const CONFLUENCE_TOKEN = process.env.CONFLUENCE_TOKEN || '';

const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_RESULTS = 5;

// Common English/log-noise words stripped out when tightening a query so the
// JQL/CQL "text ~" search matches on the meaningful technical terms instead
// of filler words.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'but', 'with', 'at', 'by', 'from', 'this', 'that', 'these', 'those', 'it',
  'as', 'likely', 'root', 'cause', 'causes', 'may', 'might', 'could', 'suggests', 'suggesting',
  'indicating', 'indicates', 'possibly', 'due', 'rather', 'than', 'not', 'no', 'if', 'which',
  'review', 'check', 'verify', 'inspect', 'separately', 'also', 'point', 'points', 'pointing',
  'contributing', 'compounding', 'likely.', 's'
]);

// Pulls the "Likely Root Cause(s)" section out of a Copilot/heuristic RCA
// narrative and reduces it to a compact set of keywords suitable as a tight
// Jira/Confluence full-text search query.
function extractSearchQuery(rcaText, maxWords = 5) {
  if (!rcaText || typeof rcaText !== 'string') return '';

  const match = rcaText.match(/Likely\s+root\s+cause\(?s?\)?\s*:?\s*([\s\S]*)/i);
  const section = match ? match[1] : rcaText;

  // Stop at the next markdown heading/bullet block or end of paragraph.
  const paragraph = section.split(/\n\s*\n/)[0] || section;

  const cleaned = paragraph
    .replace(/[*_`#>-]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-zA-Z0-9\s./_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const keywords = cleaned
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, maxWords);

  return keywords.join(' ').trim();
}

function httpGetJson(urlStr, headers) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }
    const client = target.protocol === 'http:' ? http : https;
    const req = client.get(
      target,
      { headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${e.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

async function searchJira(query) {
  if (!JIRA_BASE_URL || !JIRA_TOKEN) {
    throw new Error('Jira is not configured (missing JIRA_BASE_URL/JIRA_TOKEN).');
  }
  const jql = `text ~ "${query.replace(/"/g, '')}" ORDER BY updated DESC`;
  const url = `${JIRA_BASE_URL}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${MAX_RESULTS}&fields=summary,status,priority,updated`;
  const data = await httpGetJson(url, {
    Authorization: `Bearer ${JIRA_TOKEN}`,
    Accept: 'application/json',
  });

  return (data.issues || []).map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    priority: issue.fields?.priority?.name || '',
    updated: issue.fields?.updated || '',
    url: `${JIRA_BASE_URL}/browse/${issue.key}`,
  }));
}

async function searchConfluence(query) {
  if (!CONFLUENCE_BASE_URL || !CONFLUENCE_TOKEN) {
    throw new Error('Confluence is not configured (missing CONFLUENCE_BASE_URL/CONFLUENCE_TOKEN).');
  }
  const cql = `text ~ "${query.replace(/"/g, '')}" ORDER BY lastmodified DESC`;
  const url = `${CONFLUENCE_BASE_URL}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${MAX_RESULTS}&expand=version`;
  const data = await httpGetJson(url, {
    Authorization: `Bearer ${CONFLUENCE_TOKEN}`,
    Accept: 'application/json',
  });

  return (data.results || []).map((page) => ({
    id: page.id,
    title: page.title,
    space: page.space?.name || page._expandable?.space || '',
    lastModified: page.version?.when || '',
    url: `${CONFLUENCE_BASE_URL}${page._links?.webui || ''}`,
  }));
}

// Runs the Jira and Confluence searches in parallel; each source fails
// independently so a Confluence outage doesn't hide available Jira results
// (and vice versa).
async function lookupRelatedIssues(rcaText) {
  const query = extractSearchQuery(rcaText);
  if (!query) {
    return { query: '', jira: [], confluence: [], errors: { general: 'Could not extract a search query from the RCA text.' } };
  }

  const [jiraResult, confluenceResult] = await Promise.allSettled([
    searchJira(query),
    searchConfluence(query),
  ]);

  const errors = {};
  if (jiraResult.status === 'rejected') errors.jira = jiraResult.reason.message;
  if (confluenceResult.status === 'rejected') errors.confluence = confluenceResult.reason.message;

  return {
    query,
    jira: jiraResult.status === 'fulfilled' ? jiraResult.value : [],
    confluence: confluenceResult.status === 'fulfilled' ? confluenceResult.value : [],
    errors,
  };
}

module.exports = { lookupRelatedIssues, extractSearchQuery, searchJira, searchConfluence };
