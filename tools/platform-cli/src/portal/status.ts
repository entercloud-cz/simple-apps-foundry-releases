/**
 * `platform deploy status` (ADR-0075): how the delivery run of a commit went, from the portal API as
 * the signed-in user, never from a browser or Azure DevOps directly.
 *
 *   GET /api/apps/{slug}/runs                  the app's runs in progress and of the last half hour,
 *                                              each with its commit (the run's source version)
 *   GET /api/apps/{slug}/deployments           the deploy history, for a run that finished earlier
 *   GET /api/apps/{slug}/runs/{runId}/checks   a failed run's checks: rule IDs, the scan, each
 *                                              environment's release and smoke test
 *
 * A failed check comes with the catalogue's prompt (checkAiPrompt), the same text the portal shows.
 * The response bodies are read field by field: the CLI doesn't share the portal's types.
 */
import { checkAiPrompt } from "../explanations.js";
import type { ExplanationLanguage } from "../explanations.js";

export interface PortalGet {
  (path: string): Promise<{ status: number; body: unknown }>;
}

export interface RunStage {
  environment: string;
  state: string;
  approvers?: string;
}

export interface RunInfo {
  runId: number;
  runUrl?: string;
  status: string;
  commit?: string;
  branch?: string;
  environments: RunStage[];
}

export interface FailedCheck {
  id: string;
  environment?: string;
  places: { file: string; line?: number }[];
  details?: string[];
  prompt: string;
}

export type Outcome = "deployed" | "failed" | "running" | "notFound";

export interface StatusReport {
  app: string;
  commit: string;
  outcome: Outcome;
  run?: RunInfo;
  failed?: FailedCheck[];
  /**
   * The run's `platform check` found the agent files older than the instance's core (PC057, ADR-0076): the agent offers
   * the user `platform agent-files update` with that core's CLI.
   */
  agentFiles?: { coreVersion?: string; cliUrl?: string; prompt: string };
  /** One line each: what else the user or agent should know. */
  notes: string[];
}

/** The portal answered something the CLI can't continue from (401, 403, 404, 5xx). */
export class PortalRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const SHA_RE = /^[0-9a-f]{7,40}$/;

export function sameCommit(full: string | undefined, wanted: string): boolean {
  return full !== undefined && SHA_RE.test(full) && full.startsWith(wanted.toLowerCase());
}

function runOf(v: unknown): RunInfo | undefined {
  const r = obj(v);
  if (!r || typeof r.runId !== "number" || r.action !== "deliver") return undefined;
  const status = str(r.status);
  if (!status) return undefined;
  return {
    runId: r.runId,
    ...(str(r.runUrl) ? { runUrl: str(r.runUrl)! } : {}),
    status,
    ...(str(r.commit) ? { commit: str(r.commit)!.toLowerCase() } : {}),
    ...(str(r.branch) ? { branch: str(r.branch)! } : {}),
    environments: arr(r.environments).flatMap((e) => {
      const s = obj(e);
      const environment = str(s?.environment);
      const state = str(s?.state);
      return environment && state ? [{ environment, state, ...(str(s?.approvers) ? { approvers: str(s?.approvers)! } : {}) }] : [];
    }),
  };
}

async function read(get: PortalGet, path: string, what: string): Promise<unknown> {
  const { status, body } = await get(path);
  if (status === 200) return body;
  if (status === 401) throw new PortalRefused(401, "the portal didn't accept the sign-in: run `platform login` again");
  if (status === 403) throw new PortalRefused(403, `the portal refused the CLI ${what}`);
  if (status === 404) throw new PortalRefused(404, "the portal knows no such app, or you have no role in it (owner, deputy or developer)");
  throw new PortalRefused(status, `the portal couldn't answer ${what} (HTTP ${status}); try again in a minute`);
}

/** The failed checks of a run, each with the catalogue's prompt for the agent. */
export function failedChecks(checksBody: unknown, app: string, runUrl: string | undefined, lang: ExplanationLanguage): { failed: FailedCheck[]; notes: string[] } {
  const c = obj(checksBody);
  const failed: FailedCheck[] = [];
  const notes: string[] = [];
  if (!c || c.state === "unavailable" || c.state === "throttled") {
    notes.push("The portal can't read this run's checks right now. Ask the user to open the app's Deployments tab in the portal and paste the prompt it shows.");
    return { failed, notes };
  }
  const ctx = (extra: { environment?: string; places?: { file: string; line?: number }[]; details?: string[] }) => ({ app, ...(runUrl ? { runUrl } : {}), ...extra });
  const build = obj(c.build);
  // platform check in the build job: one entry per rule, with every place it reported.
  const byRule = new Map<string, { file: string; line?: number }[]>();
  for (const g of arr(build?.groups)) {
    const group = obj(g);
    if (group?.outcome !== "failed") continue;
    for (const f of arr(group.findings)) {
      const finding = obj(f);
      const id = str(finding?.ruleId);
      if (!id || finding?.level !== "error") continue;
      const places = byRule.get(id) ?? [];
      const file = str(finding?.file);
      if (file) places.push({ file, ...(typeof finding?.line === "number" ? { line: finding.line } : {}) });
      byRule.set(id, places);
    }
  }
  for (const [id, places] of byRule) {
    const prompt = checkAiPrompt(id, lang, ctx({ places }));
    failed.push({ id, places, prompt: prompt ?? `The platform's check ${id} failed. Run \`platform check\` and fix what it reports.` });
  }
  if (build?.outcome === "failed" && byRule.size === 0) {
    notes.push("The build failed before or outside `platform check` (the Dockerfile's build, a test, a missing file). Build the image locally (`docker build .`) and run `platform check` to see the error.");
  }
  // The vulnerability scan: findings that block (the gate's own decision).
  const scan = obj(c.scan);
  if (scan?.pass === false) {
    const details = arr(scan.top).flatMap((t) => {
      const v = obj(t);
      const id = str(v?.id);
      const pkg = str(v?.pkg);
      if (!id || !pkg) return [];
      const fixed = str(v?.fixed);
      return [`${str(v?.severity) ?? ""} ${id} in ${pkg} ${str(v?.installed) ?? ""}${fixed ? `, fixed in ${fixed}` : ", no fix yet"}`.trim()];
    });
    const prompt = checkAiPrompt("scan-gate", lang, ctx({ details }));
    if (prompt) failed.push({ id: "scan-gate", places: [], details, prompt });
  }
  // Each environment's release and its smoke test.
  for (const e of arr(c.environments)) {
    const env = obj(e);
    const environment = str(env?.environment);
    if (!environment || env?.release !== "failed") continue;
    const prompt = checkAiPrompt("deployment", lang, ctx({ environment }));
    if (prompt) failed.push({ id: "deployment", environment, places: [], prompt });
  }
  if (failed.length === 0 && notes.length === 0) {
    notes.push("The portal shows no failed check for this run (it may have been canceled). Ask the user to look at the app's Deployments tab in the portal.");
  }
  return { failed, notes };
}

/** PC057 among the run's check findings (a warning), with the core version the run's check ran with. */
export function agentFilesBehindOf(checksBody: unknown): { coreVersion?: string } | undefined {
  const c = obj(checksBody);
  const found = arr(obj(c?.build)?.groups).some((g) => arr(obj(g)?.findings).some((f) => obj(f)?.ruleId === "PC057"));
  if (!found) return undefined;
  const core = str(obj(c?.image)?.coreVersion);
  return core && /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(core) ? { coreVersion: core } : {};
}

/** The CLI tarball of a core version in the releases repository the portal names (GitHub release assets). */
export function cliDownloadUrl(releases: string | undefined, coreVersion: string | undefined): string | undefined {
  if (!releases || !coreVersion || !/^https:\/\/[^\s"'<>]+$/.test(releases)) return undefined;
  const v = coreVersion.replace(/^v/, "");
  return `${releases.replace(/\/+$/, "")}/releases/download/${coreVersion}/simple-apps-foundry-platform-cli-${v}.tgz`;
}

function outcomeOf(run: RunInfo): Outcome {
  switch (run.status) {
    case "succeeded":
      return "deployed";
    // A merge to the default branch: non-production is done, production waits for its approval.
    case "waitingForApproval":
      return run.environments.some((e) => e.state === "succeeded") ? "deployed" : "running";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "running";
  }
}

/** One look at the commit's delivery run. */
export async function deployStatus(get: PortalGet, app: string, commit: string, lang: ExplanationLanguage = "en"): Promise<StatusReport> {
  const base = `/api/apps/${encodeURIComponent(app)}`;
  const notes: string[] = [];
  const runsBody = obj(await read(get, `${base}/runs`, "the app's runs"));
  if (runsBody?.state === "unavailable") notes.push("The portal can't read the runs from Azure DevOps right now; it will look again.");
  const runs = arr(runsBody?.runs)
    .map(runOf)
    .filter((r): r is RunInfo => r !== undefined && sameCommit(r.commit, commit))
    .sort((a, b) => b.runId - a.runId);
  let run = runs[0];
  if (!run) {
    // Finished more than half an hour ago: the deploy history has it.
    const history = obj(await read(get, `${base}/deployments?limit=50`, "the deploy history"));
    const rows = arr(history?.items).flatMap((i) => {
      const d = obj(i);
      return d && typeof d.runId === "number" && sameCommit(str(d.commit)?.toLowerCase(), commit) && (d.action === undefined || d.action === "deliver")
        ? [{ runId: d.runId, environment: str(d.environment) ?? "", result: str(d.result) ?? "unknown" }]
        : [];
    });
    if (rows.length === 0) return { app, commit, outcome: "notFound", notes };
    const runId = Math.max(...rows.map((r) => r.runId));
    const mine = rows.filter((r) => r.runId === runId);
    const failedRow = mine.some((r) => r.result === "failed" || r.result === "canceled");
    run = { runId, status: failedRow ? "failed" : "succeeded", commit, environments: mine.map((r) => ({ environment: r.environment, state: r.result })) };
  }
  const outcome = outcomeOf(run);
  const report: StatusReport = { app, commit, outcome, run, notes };
  let checks: unknown;
  if (outcome === "failed") {
    checks = await read(get, `${base}/runs/${run.runId}/checks`, "the run's checks");
    const { failed, notes: more } = failedChecks(checks, app, run.runUrl, lang);
    report.failed = failed;
    notes.push(...more);
  } else if (outcome === "deployed") {
    // The warnings that concern the agent: the agent files behind the instance's core (PC057). A convenience: a
    // portal that can't read the checks now doesn't change the outcome.
    try {
      const r = await get(`${base}/runs/${run.runId}/checks`);
      if (r.status === 200) checks = r.body;
    } catch {
      checks = undefined;
    }
    notes.push("The user opens the app from its page in the portal (Open app).");
    for (const e of run.environments) {
      if (e.state === "waitingForApproval") notes.push(`${e.environment} waits for its approval${e.approvers ? ` by ${e.approvers}` : ""}: nothing for you to do.`);
    }
  }
  const behind = checks === undefined ? undefined : agentFilesBehindOf(checks);
  if (behind) {
    let releases: string | undefined;
    try {
      const cfg = obj((await get("/config.json")).body);
      releases = str(obj(cfg?.cli)?.releases);
    } catch {
      releases = undefined;
    }
    const cliUrl = cliDownloadUrl(releases, behind.coreVersion);
    report.agentFiles = { ...behind, ...(cliUrl ? { cliUrl } : {}), prompt: checkAiPrompt("PC057", lang, { app }) ?? "Run `platform agent-files update`." };
  }
  return report;
}

const short = (sha: string) => sha.slice(0, 7);

/** The report in plain text, for the agent and the user. */
export function formatStatus(r: StatusReport): string {
  const lines: string[] = [];
  const head = `${r.app}, commit ${short(r.commit)}${r.run?.branch ? ` (${r.run.branch.replace(/^refs\/heads\//, "")})` : ""}`;
  if (r.outcome === "notFound") {
    lines.push(`${head}: no delivery run for this commit yet.`);
    lines.push("A run starts a few seconds after the push. If the commit isn't pushed, push it; if the branch doesn't match deploy.branches in platform.yaml, nothing deploys.");
  } else {
    const run = r.run!;
    const word = r.outcome === "deployed" ? "deployed" : r.outcome === "failed" ? (run.status === "canceled" ? "canceled" : "failed") : run.status === "queued" ? "queued" : "running";
    lines.push(`${head}: run ${run.runId} ${word}.`);
    for (const e of run.environments) lines.push(`  ${e.environment.padEnd(10)} ${e.state}`);
  }
  for (const f of r.failed ?? []) {
    lines.push("", `Failed: ${f.id}${f.environment ? ` (${f.environment})` : ""}${f.places.length ? ` at ${f.places.map((p) => `${p.file}${p.line ? `:${p.line}` : ""}`).join(", ")}` : ""}`, f.prompt);
  }
  if (r.agentFiles) {
    const a = r.agentFiles;
    lines.push(
      "",
      `The agent files are out of date (PC057: the platform's check${a.coreVersion ? ` with core ${a.coreVersion}` : ""}). Offer the user to update them now:`,
      ...(a.coreVersion ? [`- the platform CLI ${a.coreVersion.replace(/^v/, "")}${a.cliUrl ? `: ${a.cliUrl} (check it against SHA256SUMS of the same release)` : ""}, installed with npm install --global --ignore-scripts <file>;`] : []),
      "- then `platform agent-files update`, the diff to the user, `platform check`, a commit with their OK.",
      a.prompt,
    );
  }
  if (r.notes.length) lines.push("", ...r.notes);
  return lines.join("\n") + "\n";
}

/** Exit code of a report: 0 deployed, 1 failed or canceled, 3 still running or not found yet. */
export function exitCodeOf(r: StatusReport): number {
  return r.outcome === "deployed" ? 0 : r.outcome === "failed" ? 1 : 3;
}
