import type { Report } from "../run.js";

/** Machine-readable report. `findings` is the flat list; `checks` keeps per-group status. */
export function formatJson(report: Report): string {
  const body = {
    tool: report.tool,
    directory: report.directory,
    options: report.options,
    summary: report.summary,
    result: report.exitCode === 0 ? "passed" : "failed",
    checks: report.results.map((r) => ({
      group: r.group,
      status: r.skipped && !r.findings.some((f) => f.severity === "error") ? "skipped" : r.findings.some((f) => f.severity === "error") ? "failed" : r.findings.length ? "warnings" : "ok",
      ...(r.skipped ? { skipReason: r.skipped.reason } : {}),
      ...(r.notes?.length ? { notes: r.notes } : {}),
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    })),
    findings: report.findings.map(({ fingerprintSeed: _seed, ...f }) => f),
  };
  return JSON.stringify(body, null, 2) + "\n";
}
