const path = require('path');

const ALLOWED_APPS = new Map([
  'replace_node',
  'add_node',
  'ipsec',
  'ram',
  'dns',
  'interface10Gig',
  'ntp',
  'etcd',
  'disk',
  'pv',
  'ads',
  'postgres',
  'cassandra',
  'opensearch',
  'minio',
  'zookeeper',
  'kafka',
  'rabbitmq',
  'redis',
].map((name) => [name.toLowerCase(), name]));

const TIMESTAMP_SOURCE = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{2}-\\d{2}-\\d{4})[T _]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|\\s*UTC|[+-]\\d{2}:?\\d{2})?';

function formatTimestamp(value) {
  return value
    .replace(/^((?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}))[T_]/, '$1 ')
    .replace(/,(?=\d)/, '.')
    .trim();
}

function extractIvtTimeRange(text) {
  const content = String(text || '');
  const startMatch = content.match(new RegExp(`^\\s*(?:IVT\\s+)?Start\\s+Time\\s*[:=-]\\s*(${TIMESTAMP_SOURCE})`, 'im'));
  const endMatch = content.match(new RegExp(`^\\s*(?:IVT\\s+)?End\\s+Time\\s*[:=-]\\s*(${TIMESTAMP_SOURCE})`, 'im'));
  const lineTimestamp = content.match(new RegExp(`^[\\t ]*(${TIMESTAMP_SOURCE})`, 'im'));
  const boundaryIndex = lineTimestamp ? lineTimestamp.index : 0;
  const timestamps = Array.from(content.matchAll(new RegExp(TIMESTAMP_SOURCE, 'gi')))
    .filter((match) => match.index >= boundaryIndex);

  return {
    startTime: startMatch
      ? formatTimestamp(startMatch[1])
      : lineTimestamp
        ? formatTimestamp(lineTimestamp[1])
        : timestamps[0]
          ? formatTimestamp(timestamps[0][0])
          : null,
    endTime: endMatch
      ? formatTimestamp(endMatch[1])
      : timestamps.length > 0
        ? formatTimestamp(timestamps[timestamps.length - 1][0])
        : null,
  };
}

function parseIvtContent(text) {
  const components = new Map();

  String(text || '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const match = line.match(/\bApp:\s*([^,]+?)\s*,\s*Status:\s*(success|failure)(?=\s*(?:,|$))/i);
    if (!match) return;

    const componentName = ALLOWED_APPS.get(match[1].trim().toLowerCase());
    if (!componentName) return;

    const status = match[2].toLowerCase();

    const existing = components.get(componentName);
    const detail = {
      line: index + 1,
      text: line.slice(0, 500),
      status,
      returnValue: null,
    };

    if (existing) {
      existing.checks += 1;
      existing.details.push(detail);
      if (status === 'failure') existing.status = 'failure';
    } else {
      components.set(componentName, {
        name: componentName,
        status,
        checks: 1,
        details: [detail],
      });
    }
  });

  return Array.from(components.values());
}

function analyzeIvtFile(file, readText) {
  const text = readText(file.fullPath);
  const components = parseIvtContent(text);
  const { startTime, endTime } = extractIvtTimeRange(text);
  return {
    name: path.basename(file.relPath),
    path: file.relPath.split(path.sep).join('/'),
    status: components.some((component) => component.status === 'failure') ? 'failure' : components.length > 0 ? 'success' : 'unknown',
    startTime,
    endTime,
    components,
  };
}

module.exports = { analyzeIvtFile, extractIvtTimeRange, parseIvtContent };