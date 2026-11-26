import { adoContext, adoRequest, listValue } from "./ado.js";
import type { AdoContext } from "./ado.js";
import { COMMIT_RE, CheckFailed, ENV_NAME_RE, REF_RE, isObject, own, slugProblem } from "./common.js";

/**
 * REST calls (api-version 7.1, Microsoft Learn "Azure DevOps Services REST API"):
 * - GET  {project}/_apis/build/builds/{runId}                     Build: definition.id, status, deleted
 * - GET  {project}/_apis/pipelines/{definitionId}/runs/{runId}    Run: resources.repositories.app.{refName,version}
 * - GET  {project}/_apis/build/builds/{runId}/timeline            Timeline: records[] {id, parentId, type, identifier, name, state, result}
 * - GET  {project}/_apis/build/retention/leases?ownerId&definitionId&runId
 * - POST {project}/_apis/build/retention/leases                   body NewRetentionLease[]
 * - PATCH {project}/_apis/build/retention/leases/{leaseId}         body RetentionLeaseUpdate
 *
 * Timeline records of YAML runs (checked against sandbox run 2874): type "Stage" with
 * identifier = YAML stage name (`name` is the displayName); type "Phase" with identifier
 * `<stage>.<job>`; type "Job" with identifier `<stage>.<job>.__default` for a regular job and
 * `<stage>.<job>.<hook>` (e.g. deploy_prod.release.release) for a deployment job.
 */

export const SUCCEEDED = "succeeded";

interface TimelineRecord {
  id: string;
  parentId: string | null;
  type: string;
  identifier: string | null;
  name: string | null;
  state: string | null;
  result: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function parseTimeline(v: unknown): TimelineRecord[] {
  if (!isObject(v) || !Array.isArray(own(v, "records"))) throw new CheckFailed(["the source run's timeline has no records."]);
  return (own(v, "records") as unknown[]).filter(isObject).map((r) => ({
    id: str(own(r, "id")) ?? "",
    parentId: str(own(r, "parentId")),
    type: str(own(r, "type")) ?? "",
    identifier: str(own(r, "identifier")),
    name: str(own(r, "name")),
    state: str(own(r, "state")),
    result: str(own(r, "result")),
  }));
}

/** The Stage record of a YAML stage name (identifier; name only when a record has no identifier). */
export function stageRecord(records: TimelineRecord[], stage: string): TimelineRecord | undefined {
  const stages = records.filter((r) => r.type === "Stage");
  return stages.find((r) => r.identifier === stage) ?? stages.find((r) => r.identifier === null && r.name === stage);
}

/**
 * Records of a regular (non-deployment) job: its Phase `<stage>.<job>` and its Job
 * `<stage>.<job>.__default` (no matrix). Identifiers as in the timeline of sandbox run 2874.
 */
export function jobRecords(records: TimelineRecord[], stage: string, job: string): TimelineRecord[] {
  return records.filter(
    (r) => (r.type === "Phase" && r.identifier === `${stage}.${job}`) || (r.type === "Job" && r.identifier === `${stage}.${job}.__default`),
  );
}

export interface SourceRun {
  runId: number;
  commit: string;
  appRef: string;
  path: "rollback" | "promotion";
}

export interface VerifyArgs {
  runId: string;
  target: string;
  promoteFrom: string;
  defaultBranch: string;
  targetKind: string;
}

function checkArgs(a: VerifyArgs): number {
  const problems: string[] = [];
  if (!/^[1-9][0-9]{0,9}$/.test(a.runId) || Number(a.runId) > 2_147_483_647) problems.push("--run-id must be a positive run id.");
  if (!ENV_NAME_RE.test(a.target)) problems.push("--target must be an environment name.");
  if (a.promoteFrom !== "" && (!ENV_NAME_RE.test(a.promoteFrom) || a.promoteFrom === a.target)) problems.push("--promote-from must be '' or another environment name.");
  if (!a.defaultBranch.startsWith("refs/heads/") || a.defaultBranch === "refs/heads/" || !REF_RE.test(a.defaultBranch)) problems.push('--default-branch must be a branch ref starting with "refs/heads/".');
  if (a.targetKind !== "prod" && a.targetKind !== "nonprod") problems.push("--target-kind must be prod or nonprod.");
  if (problems.length) throw new CheckFailed(problems);
  return Number(a.runId);
}

/**
 * `verify-source-run`: may the artifacts of run `runId` be (re)deployed to `target`?
 * - same pipeline definition, run completed (and not deleted), its job verify.scan succeeded;
 * - path rollback: its stage deploy_<target> succeeded; or
 *   path promotion: promoteFrom set, its stage deploy_<promoteFrom> succeeded and its app ref is
 *   the default branch;
 * - target of kind prod: the app ref is the default branch on both paths (ADR-0029 item 6).
 * Only `succeeded` counts: `succeededWithIssues` on a deploy stage is how deploy.sh reports
 * "nothing to do" (newer run already deployed, source not published), so it is not a deployment.
 */
export async function verifySourceRun(a: VerifyArgs, env: NodeJS.ProcessEnv, ctx: AdoContext = adoContext(env)): Promise<SourceRun> {
  const runId = checkArgs(a);

  const build = await adoRequest(ctx, "GET", `build/builds/${runId}`);
  if (!isObject(build)) throw new CheckFailed(["the source run is not a build object."]);
  const def = own(build, "definition");
  const problems: string[] = [];
  if (own(build, "id") !== runId) problems.push(`run ${runId}: the API returned another run.`);
  if (!isObject(def) || own(def, "id") !== ctx.definitionId) problems.push(`run ${runId} belongs to another pipeline, not to this one (definition ${ctx.definitionId}).`);
  if (own(build, "deleted") === true) problems.push(`run ${runId} has been deleted.`);
  if (own(build, "status") !== "completed") problems.push(`run ${runId} has not completed (status ${String(own(build, "status")).slice(0, 20)}).`);
  if (problems.length) throw new CheckFailed(problems);

  const run = await adoRequest(ctx, "GET", `pipelines/${ctx.definitionId}/runs/${runId}`);
  const resources = isObject(run) ? own(run, "resources") : undefined;
  const repos = isObject(resources) ? own(resources, "repositories") : undefined;
  const app = isObject(repos) ? own(repos, "app") : undefined;
  const appRef = isObject(app) ? own(app, "refName") : undefined;
  const commit = isObject(app) ? own(app, "version") : undefined;
  if (typeof appRef !== "string" || !REF_RE.test(appRef)) throw new CheckFailed([`run ${runId} has no app repository ref (resources.repositories.app.refName).`]);
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) throw new CheckFailed([`run ${runId} has no app commit (resources.repositories.app.version).`]);

  const records = parseTimeline(await adoRequest(ctx, "GET", `build/builds/${runId}/timeline`));
  const scan = jobRecords(records, "verify", "scan");
  if (scan.length === 0) throw new CheckFailed([`run ${runId} has no verify.scan job: it is not a build run of this pipeline (a redeploy run cannot be a source).`]);
  if (!scan.every((j) => j.result === SUCCEEDED)) throw new CheckFailed([`run ${runId}: its scan job did not succeed.`]);

  const onDefault = appRef === a.defaultBranch;
  const deployedTo = (envName: string): boolean => stageRecord(records, `deploy_${envName}`)?.result === SUCCEEDED;
  let path: SourceRun["path"];
  if (deployedTo(a.target)) path = "rollback";
  else if (a.promoteFrom !== "" && deployedTo(a.promoteFrom) && onDefault) path = "promotion";
  else {
    const why =
      a.promoteFrom === ""
        ? `its stage deploy_${a.target} did not succeed`
        : `neither its stage deploy_${a.target} nor deploy_${a.promoteFrom} succeeded${deployedTo(a.promoteFrom) && !onDefault ? " on the default branch" : ""}`;
    throw new CheckFailed([`run ${runId} cannot be deployed to ${a.target}: ${why}.`]);
  }
  if (a.targetKind === "prod" && !onDefault) {
    throw new CheckFailed([`run ${runId} was built from ${appRef}, not from the default branch ${a.defaultBranch}; prod only receives default-branch builds.`]);
  }
  return { runId, commit, appRef, path };
}

// ------------------------------------------------------------------------------------------
// retention-lease
// ------------------------------------------------------------------------------------------

export interface LeaseArgs {
  runId: string;
  env: string;
  days: string;
  slug: string;
  ownerPrefix: string;
}

export interface LeaseResult {
  leaseId: number;
  ownerId: string;
  runId: number;
  validUntil: string | null;
  action: "created" | "renewed";
}

function leaseOf(v: unknown, label: string): { leaseId: number; validUntil: string | null } {
  if (!isObject(v) || typeof own(v, "leaseId") !== "number") throw new CheckFailed([`${label}: unexpected response shape.`]);
  return { leaseId: own(v, "leaseId") as number, validUntil: str(own(v, "validUntil")) };
}

/**
 * `retention-lease`: keeps the artifacts of a deployed run (rollback stays possible). One lease per
 * owner `<prefix>:<slug>:<env>` and run: renewed (PATCH daysValid) when it exists, created otherwise.
 * protectPipeline is false, so decommissioning can still delete the pipeline.
 * TODO(verify) ADO-22: the job token may create and update leases.
 */
export async function retentionLease(a: LeaseArgs, env: NodeJS.ProcessEnv, ctx: AdoContext = adoContext(env)): Promise<LeaseResult> {
  const problems: string[] = [];
  if (!/^[1-9][0-9]{0,9}$/.test(a.runId) || Number(a.runId) > 2_147_483_647) problems.push("--run-id must be a positive run id.");
  if (!ENV_NAME_RE.test(a.env)) problems.push("--env must be an environment name.");
  if (!/^[1-9][0-9]{0,4}$/.test(a.days) || Number(a.days) > 36500) problems.push("--days must be a whole number from 1 to 36500.");
  const sp = slugProblem(a.slug, "--slug");
  if (sp) problems.push(sp);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(a.ownerPrefix)) problems.push("--owner-prefix must be 1-40 lowercase letters, digits and hyphens.");
  if (problems.length) throw new CheckFailed(problems);
  const runId = Number(a.runId);
  const days = Number(a.days);
  const ownerId = `${a.ownerPrefix}:${a.slug}:${a.env}`;

  const existing = listValue(
    await adoRequest(ctx, "GET", "build/retention/leases", { ownerId, definitionId: String(ctx.definitionId), runId: String(runId) }),
    "GET _apis/build/retention/leases",
  ).filter((l) => isObject(l) && own(l, "ownerId") === ownerId && own(l, "runId") === runId);

  if (existing.length) {
    const first = leaseOf(existing[0], "existing lease");
    const updated = leaseOf(
      await adoRequest(ctx, "PATCH", `build/retention/leases/${first.leaseId}`, {}, { daysValid: days, protectPipeline: false }),
      "PATCH _apis/build/retention/leases",
    );
    return { leaseId: updated.leaseId, ownerId, runId, validUntil: updated.validUntil, action: "renewed" };
  }
  const created = listValue(
    await adoRequest(ctx, "POST", "build/retention/leases", {}, [{ daysValid: days, definitionId: ctx.definitionId, ownerId, protectPipeline: false, runId }]),
    "POST _apis/build/retention/leases",
  );
  const lease = leaseOf(created[0], "POST _apis/build/retention/leases");
  return { leaseId: lease.leaseId, ownerId, runId, validUntil: lease.validUntil, action: "created" };
}
