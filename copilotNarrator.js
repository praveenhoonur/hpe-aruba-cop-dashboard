const { execFile } = require('child_process');

const COPILOT_TIMEOUT_MS = 120 * 1000; // headless Copilot CLI calls can take up to ~1-2 min
const MAX_PROMPT_CHARS = 12000; // keep the prompt compact to control cost/latency

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}\n...[truncated]` : str;
}

// Builds a compact, structured prompt from the already-parsed analysis
// (summary metrics + a sample of the highest-signal lines) rather than
// dumping the entire raw log, to keep the Copilot CLI call fast and cheap.
function buildPrompt(analysis) {
  const lines = [];
  lines.push(
    'You are analyzing a parsed Kubernetes/COP (Central Orchestrator Platform) cluster health-check report.',
    'Do NOT run any shell commands, do NOT read or write any files, and do NOT use any tools — only reason over the structured data below.',
    'Respond with a concise narrative (200 words max) covering: overall health, the most significant issues, and the most likely root cause(s).',
    ''
  );

  if (analysis.clusterFqdn) {
    lines.push(`Cluster: ${analysis.clusterFqdn}`);
  }

  if (analysis.summary) {
    lines.push(
      `Overall status: ${analysis.summary.status}`,
      `Totals across all sections — errors: ${analysis.summary.totals.error}, warnings: ${analysis.summary.totals.warn}, info: ${analysis.summary.totals.info}`,
      'Key metrics:'
    );
    for (const m of analysis.summary.metrics || []) {
      lines.push(`  - ${m.label}: ${m.value} [${m.level}]`);
    }
    lines.push('');
  }

  // Sample the most relevant lines per section (errors/warnings first) so the
  // model has concrete evidence without needing the full multi-thousand-line log.
  if (Array.isArray(analysis.sections)) {
    lines.push('Notable lines per section (errors/warnings prioritized):');
    for (const section of analysis.sections) {
      const notable = section.entries
        .filter((e) => e.level === 'error' || e.level === 'warn')
        .slice(0, 5);
      if (notable.length === 0) continue;
      lines.push(`\n[${section.title}]`);
      notable.forEach((e) => lines.push(`  ${e.text}`));
    }
  }

  return truncate(lines.join('\n'), MAX_PROMPT_CHARS);
}

// Invokes the headless GitHub Copilot CLI (`copilot -p ... -s`) to turn the
// deterministic analysis into a natural-language narrative + likely root
// cause. Requires the `copilot` binary to be installed and authenticated
// (COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, or a prior `copilot login`)
// on the machine running this server.
function generateCopilotNarrative(analysis) {
  return new Promise((resolve, reject) => {
    const prompt = buildPrompt(analysis);

    execFile(
      'copilot',
      ['-p', prompt, '--no-color', '-s', '--allow-all-tools'],
      { timeout: COPILOT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            return reject(new Error('Copilot CLI is not installed on this server.'));
          }
          if (err.killed) {
            return reject(new Error('Copilot CLI call timed out.'));
          }
          return reject(new Error(stderr?.trim() || err.message));
        }
        resolve(stdout.trim());
      }
    );
  });
}

module.exports = { generateCopilotNarrative };
