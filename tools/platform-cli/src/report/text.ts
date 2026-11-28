import type { Report } from "../run.js";
import { GROUP_TITLES } from "../types.js";
import type { CheckResult, Finding } from "../types.js";

export interface TextOptions {
  color: boolean;
  /** Print the AI prompt hint for each finding. */
  aiPrompts: boolean;
}

const ANSI = { red: "31", yellow: "33", green: "32", cyan: "36", dim: "2", bold: "1" } as const;

function paint(on: boolean, code: keyof typeof ANSI, s: string): string {
  return on ? `\u001b[${ANSI[code]}m${s}\u001b[0m` : s;
}

function loc(f: Finding): string {
  if (!f.file) return "";
  return f.line ? `${f.file}:${f.line}` : f.file;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 3) + "..." : flat;
}

function indentLines(s: string, pad: string): string {
  return s.split("\n").map((l, i) => (i === 0 ? l : pad + l)).join("\n");
}

function status(r: CheckResult): { label: string; color: "red" | "yellow" | "green" | "cyan" } {
  if (r.skipped && !r.findings.some((f) => f.severity === "error")) return { label: "SKIPPED", color: "cyan" };
  if (r.findings.some((f) => f.severity === "error")) return { label: "FAILED", color: "red" };
  if (r.findings.some((f) => f.severity === "warning")) return { label: "WARNINGS", color: "yellow" };
  return { label: "OK", color: "green" };
}

export function formatText(report: Report, opts: TextOptions): string {
  const c = opts.color;
  const out: string[] = [];
  out.push(paint(c, "bold", `platform check`) + `  ${report.directory}`);
  out.push(paint(c, "dim", `${report.tool.name} ${report.tool.version}${report.options.strict ? "  (strict)" : ""}`));
  out.push("");

  for (const r of report.results) {
    const st = status(r);
    const errors = r.findings.filter((f) => f.severity === "error").length;
    const warnings = r.findings.filter((f) => f.severity === "warning").length;
    const counts = [errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
    out.push(`${paint(c, "bold", GROUP_TITLES[r.group])}  ${paint(c, st.color, `[${st.label}]`)}${counts ? "  " + counts : ""}`);
    if (r.skipped) out.push(`  ${paint(c, "cyan", "SKIPPED")} ${r.skipped.reason}`);
    for (const f of r.findings) {
      const sev = f.severity === "error" ? paint(c, "red", "ERROR  ") : f.severity === "warning" ? paint(c, "yellow", "WARNING") : paint(c, "cyan", "NOTE   ");
      const where = loc(f);
      out.push(`  ${sev} ${paint(c, "bold", f.ruleId)}${where ? "  " + where : ""}`);
      out.push(`          ${indentLines(f.message, "          ")}`);
      out.push(`          ${paint(c, "green", "Fix:")} ${f.hint}`);
      if (opts.aiPrompts) out.push(`          ${paint(c, "dim", "AI prompt:")} ${paint(c, "dim", oneLine(f.aiPrompt, 360))}`);
    }
    for (const n of r.notes ?? []) out.push(`  ${paint(c, "dim", n)}`);
    out.push("");
  }

  const s = report.summary;
  const verdict = report.exitCode === 0 ? paint(c, "green", "PASSED") : paint(c, "red", "FAILED");
  out.push(
    `${paint(c, "bold", "Result:")} ${verdict}  (${s.errors} error${s.errors === 1 ? "" : "s"}, ${s.warnings} warning${s.warnings === 1 ? "" : "s"}, ${s.skipped} skipped check${s.skipped === 1 ? "" : "s"})`,
  );
  if (report.exitCode !== 0) out.push(paint(c, "dim", 'Fix the errors above and run "platform check" again. Warnings do not block.'));
  return out.join("\n") + "\n";
}
