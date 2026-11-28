import { loadAllowlist, UsageError } from "./allowlist.js";
import type { Allowlist } from "./allowlist.js";
import { loadLayout } from "./agentfiles.js";
import { checkAccess } from "./checks/access.js";
import { checkAgentFiles } from "./checks/agentfiles.js";
import { checkDockerfile } from "./checks/dockerfile.js";
import { checkDocs } from "./checks/docs.js";
import { checkForbidden } from "./checks/forbidden.js";
import { checkManifest } from "./checks/manifest.js";
import { checkRuntime } from "./checks/runtime.js";
import { checkSecrets } from "./checks/secrets.js";
import { Context } from "./context.js";
import { enforceFindings } from "./enforcement.js";
import { finding } from "./rules.js";
import { GROUP_ORDER } from "./types.js";
import { toolVersion } from "./version.js";
import type { CheckOptions, CheckResult, Finding, GroupId } from "./types.js";

export interface Report {
  tool: { name: string; version: string };
  directory: string;
  options: { strict: boolean; skipRuntime: boolean; only?: GroupId[] };
  results: CheckResult[];
  findings: Finding[];
  summary: { errors: number; warnings: number; notes: number; skipped: number };
  exitCode: 0 | 1;
}

export { toolVersion };

export function defaultOptions(dir: string): CheckOptions {
  return { dir, skipRuntime: false, strict: false, maxFileMb: 5, gitleaks: "auto", smokeTimeoutSec: 60 };
}

export function parseGroups(list: string): GroupId[] {
  const names = list.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !GROUP_ORDER.includes(n as GroupId));
  if (bad.length) throw new UsageError(`Unknown check group(s): ${bad.join(", ")}. Valid: ${GROUP_ORDER.join(", ")}`);
  return names as GroupId[];
}

export async function runChecks(options: CheckOptions): Promise<Report> {
  if (options.strict && options.skipRuntime) {
    throw new UsageError("--strict and --skip-runtime cannot be combined: in CI the runtime smoke test must not be skippable.");
  }
  const ctx = new Context(options);
  const allowlistPath = options.allowlistPath ?? process.env.PLATFORM_SECRETS_ALLOWLIST;
  const allowlist: Allowlist | undefined = allowlistPath ? loadAllowlist(allowlistPath, ctx.dir) : undefined;
  const layout = loadLayout(options.agentManifestPath ?? process.env.PLATFORM_AGENT_FILES_MANIFEST);

  const wanted = (g: GroupId): boolean => !options.only || options.only.includes(g);
  const results: CheckResult[] = [];
  const timed = async (fn: () => CheckResult | Promise<CheckResult>): Promise<void> => {
    const t0 = Date.now();
    const r = await fn();
    results.push({ ...r, durationMs: Date.now() - t0 });
  };

  if (wanted("manifest")) await timed(() => checkManifest(ctx));
  if (wanted("dockerfile")) await timed(() => checkDockerfile(ctx));
  if (wanted("secrets")) await timed(() => checkSecrets(ctx, allowlist));
  if (wanted("forbidden-files")) await timed(() => checkForbidden(ctx));
  if (wanted("docs")) await timed(() => checkDocs(ctx));
  if (wanted("access")) await timed(() => checkAccess(ctx));
  if (wanted("agent-files")) await timed(() => checkAgentFiles(ctx, layout));
  if (wanted("runtime")) await timed(() => checkRuntime(ctx));

  if (options.strict) {
    for (const r of results) {
      if (r.skipped && !r.skipped.strictExempt) {
        const id = r.group === "runtime" ? "PC060" : "PC021";
        r.findings.push(
          finding(id, {
            message: `Check skipped, which is not allowed with --strict: ${r.skipped.reason}.`,
            hint:
              r.group === "runtime"
                ? "In CI, docker must be available so the app is really started and tested."
                : "Install the missing tool so the check can run.",
            aiPrompt: `Make the required tool available (${r.skipped.reason}) and re-run "platform check --strict".`,
          }),
        );
      }
    }
  }

  // Checks that warn before they block (rules.ts enforceFrom, ADR-0049 section 7).
  for (const r of results) r.findings = enforceFindings(r.findings, options.today);
  const findings = results.flatMap((r) => r.findings);
  const summary = {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    notes: findings.filter((f) => f.severity === "note").length,
    skipped: results.filter((r) => r.skipped).length,
  };
  return {
    tool: { name: "@simple-apps-foundry/platform-cli", version: toolVersion() },
    directory: ctx.dir,
    options: { strict: options.strict, skipRuntime: options.skipRuntime, ...(options.only ? { only: options.only } : {}) },
    results,
    findings,
    summary,
    exitCode: summary.errors > 0 ? 1 : 0,
  };
}
