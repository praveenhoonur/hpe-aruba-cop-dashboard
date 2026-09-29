---
name: support-bundle-rca
description: "Use when analyzing HPE Aruba COP or Kubernetes support bundles, sanity-check logs, pod logs, cluster-health reports, or uploaded diagnostic archives to produce an evidence-based root-cause analysis (RCA)."
---

# Support Bundle RCA

Analyze an HPE Aruba COP/Kubernetes support bundle and produce a concise, evidence-based RCA. Treat heuristic matches and AI-generated prose as hypotheses until they are supported by concrete log evidence.

## Inputs

Accept a single log/text file or an archive with one of these extensions: `.log`, `.txt`, `.tar`, `.tar.gz`, `.tgz`, `.zip`, or `.tar.zip`. Record the original filename and, for archives, preserve each finding's relative file path.

Before analysis, confirm:

- The input is readable and within the application's 500 MB upload limit.
- An archive can be extracted safely and its contents can be enumerated.
- The time range, cluster identity, COP version, and relevant node/pod names are available; mark any missing context as unknown.
- Secrets, tokens, credentials, and unrelated personal data are excluded from the report.

## Workflow

1. **Inventory the bundle.** List files, sizes, paths, and obvious metadata. Ignore operating-system noise such as `.DS_Store` and `._*` files. Separate the canonical `cop_sanity_logs-YYYYMMDD-HHMMSS.log` file from other logs when present.

2. **Parse the sanity log.** Split banner-delimited `STEP: <category>` sections. For every section, count error-like, warning-like, informational, and neutral lines. Preserve the source line text and section name as evidence. Detect structured whitespace tables only when all rows have the same column count; otherwise retain line-oriented evidence.

3. **Build the health baseline.** Extract concrete signals where present: COP and host versions, node readiness, control-plane component health, pod totals and running/not-running counts, restart hotspots, Kubernetes warning events, and disk usage by node. Report both numerator and denominator for ratios, and distinguish absent data from a healthy zero.

4. **Scan supporting files.** Group files by their immediate parent directory and inspect each file for known signatures. Prioritize OOMKilled/out-of-memory, CrashLoopBackOff, image-pull failures, probe failures, connection refusal/timeouts, permission or authentication failures, disk pressure, DNS failures, and generic errors. For each signature, retain a count, the affected file paths, and a short representative line.

5. **Rank hypotheses.** Rank candidate causes by the strength and specificity of evidence, not by raw error count alone. Correlate timestamps, affected components, node/pod names, restart behavior, resource pressure, and dependency failures. Separate:
   - **Primary cause:** the earliest or most direct failure that explains downstream symptoms.
   - **Contributing factors:** conditions that increased likelihood or impact.
   - **Symptoms:** observed consequences that should not be presented as causes.
   - **Unknowns:** missing evidence that prevents confirmation.

6. **Use deep search selectively.** Search retained bundle contents for a targeted term, regex, or boolean query when a hypothesis needs confirmation. Prefer focused queries such as `error AND timeout` or `CrashLoopBackOff OR OOMKilled`. Treat capped or expired results as incomplete evidence and say so.

7. **Optionally enrich with AI and history.** Pass only the parsed summary and a small sample of high-signal lines to Copilot narration. The narrative must not invent facts or claim certainty beyond the evidence. Derive a compact technical query from the likely-root-cause section before looking up related Jira or Confluence issues. Report Jira and Confluence failures independently; external matches are context, not proof.

8. **Write the RCA.** Use the report format below. Keep claims traceable to file paths, section names, line numbers when available, timestamps, counts, or representative excerpts.

## RCA Report Format

```markdown
# Root-Cause Analysis

## Executive Summary
- Impact:
- Overall health:
- Confidence: High | Medium | Low

## Evidence
- [path or section] observation; include timestamp/count/excerpt

## Likely Root Cause
1. Cause: ...
   Evidence: ...
   Confidence: ...

## Contributing Factors
- ...

## Symptoms and Scope
- Affected components/nodes/pods:
- First known failure:
- Downstream effects:

## Recommended Actions
1. Immediate containment:
2. Verification:
3. Corrective change:
4. Prevention/monitoring:

## Unknowns and Follow-up
- Missing artifact or query needed to confirm/refute each uncertainty.
```

## Quality Gates

Before finalizing, verify:

- Every asserted cause has at least one concrete supporting observation.
- The report distinguishes direct evidence, inference, and uncertainty.
- The first known failure is not replaced by a later, louder symptom.
- Counts and ratios use the correct denominator and do not treat missing sections as healthy.
- Large or skipped files, capped searches, expired uploads, parse failures, and unavailable integrations are disclosed.
- Recommendations are specific, reversible where possible, and tied to the suspected cause.
- No secrets or unnecessary raw log content are reproduced.
- The final report is concise enough to scan but includes paths and excerpts needed for verification.

## Completion Criteria

The task is complete when the input inventory, health baseline, ranked RCA hypotheses, supporting evidence, recommended actions, confidence level, and unresolved unknowns are all present. If the evidence cannot establish a root cause, explicitly deliver a constrained differential diagnosis rather than forcing a definitive conclusion.