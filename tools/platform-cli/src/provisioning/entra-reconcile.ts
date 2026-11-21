import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, ENV_NAME_RE, MiB, SLUG_RE, UsageError, isObject, own, readJson, writeJson } from "../pipeline/common.js";
import { Client, GUID_RE, endpoint, messages, oneLine, token } from "./easyauth.js";
import { ENTRA_UNIQUE_NAME_RE, entraApplicationUniqueName } from "./names.js";
import { armValue, parseRecord } from "./run.js";

/**
 * What Graph Bicep doesn't delete (ADR-0023, ADR-0033 amended 2026-11-11, US06.03).
 *
 * Graph Bicep deployments are incremental: an `appRoleAssignedTo` the template no longer declares
 * stays in Entra, and an app role dropped from `appRoles` is refused by Graph while it is enabled.
 * Two commands close that gap, one per stage:
 *
 * `entra-removals` (stage entra_plan, pure): what the platform itself assigned and app.yaml no longer
 * lists. "The platform's own" is the parameter set of the last deployment entra-{slug}-{env}: only
 * an assignment that deployment declared (principal and role) is ever removed, so an assignment
 * someone made by hand in the enterprise application (one the platform never declared) is never
 * touched. The same for app roles: a role of the record's appRoles that the inputs no longer have
 * is retired: disabled (isEnabled false) by a first deployment, then removed by the second. When
 * a role must be disabled first, --disable-output gets those first inputs: the final inputs plus
 * the retired roles with isEnabled false (what the entra stage deploys before the final inputs).
 *
 * `entra-reconcile` (stage entra, Microsoft Graph with the Entra provisioning identity's token):
 * deletes the planned assignments, before the stage deploys the registration, so a failure keeps
 * the old record and the next run plans the same removal again. It never trusts the record for
 * where to delete: it resolves the app's own registration by its uniqueName ({prefix}-{slug}-{env}, with
 * --i{incarnation} above incarnation 0, ADR-0061; from names.bicep), then its service principal, lists that service principal's appRoleAssignedTo
 * and deletes only an assignment that is on that service principal (resourceId), of a User or
 * Group, for a planned principal and the planned role's id on that application. An assignment the
 * final inputs still list is never deleted. A planned assignment that is already gone is reported
 * as such (idempotent). Permissions: Application.Read.All (read the application, the service
 * principal and its assignments) and AppRoleAssignment.ReadWrite.All (delete), both already held
 * by the identity (ADR-0023); no new permission. Verify in sandbox: ENT-3.
 */

const ROLE_VALUE_RE = /^[A-Za-z][A-Za-z0-9.]{0,19}$/;
const PREFIX_RE = /^[a-z][a-z0-9]{1,7}$/;
const DEFAULT_GRAPH = "https://graph.microsoft.com/";
/** appRoleAssignedTo pages followed at most (999 per page). */
const MAX_PAGES = 20;

export interface Assignment {
  principalId: string;
  role: string;
}

export interface AppRole {
  value: string;
  displayName: string;
  description: string;
  isEnabled?: boolean;
}

export interface RetiredRole {
  value: string;
  displayName: string;
  description: string;
  /** The record's deployment left it enabled: it is disabled by a first deployment. */
  enabledInRecord: boolean;
}

export interface Removals {
  prefix: string;
  slug: string;
  environmentName: string;
  assignments: Assignment[];
  roles: RetiredRole[];
}

interface EntraInputs {
  prefix: string;
  slug: string;
  environmentName: string;
  /** app.yaml incarnation (ADR-0061): with prefix, slug and environment, it names the registration. */
  incarnation: number;
  appRoles: AppRole[];
  roleAssignments: Assignment[];
  raw: Record<string, unknown>;
}

const key = (a: Assignment): string => `${a.principalId.toLowerCase()}|${a.role}`;

function assignmentsOf(v: unknown, label: string): Assignment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new CheckFailed([`${label} must be an array of {principalId, role}.`]);
  return v.map((a, i) => {
    const principalId = isObject(a) ? own(a, "principalId") : undefined;
    const role = isObject(a) ? own(a, "role") : undefined;
    if (typeof principalId !== "string" || !GUID_RE.test(principalId) || typeof role !== "string" || !ROLE_VALUE_RE.test(role)) {
      throw new CheckFailed([`${label}[${i}] must be {principalId: <GUID>, role: <role value>}.`]);
    }
    return { principalId, role };
  });
}

function rolesOf(v: unknown, label: string): AppRole[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new CheckFailed([`${label} must be an array of app roles.`]);
  return v.map((r, i) => {
    const value = isObject(r) ? own(r, "value") : undefined;
    const displayName = isObject(r) ? own(r, "displayName") : undefined;
    const description = isObject(r) ? own(r, "description") : undefined;
    const isEnabled = isObject(r) ? own(r, "isEnabled") : undefined;
    if (
      typeof value !== "string" ||
      !ROLE_VALUE_RE.test(value) ||
      typeof displayName !== "string" ||
      displayName.length < 1 ||
      displayName.length > 100 ||
      typeof description !== "string" ||
      description.length > 250 ||
      (isEnabled !== undefined && typeof isEnabled !== "boolean")
    ) {
      throw new CheckFailed([`${label}[${i}] must be {value, displayName (1-100), description (at most 250)[, isEnabled]}.`]);
    }
    return { value, displayName, description, ...(isEnabled !== undefined ? { isEnabled } : {}) };
  });
}

function identity(o: Record<string, unknown>, label: string): { prefix: string; slug: string; environmentName: string } {
  const prefix = own(o, "prefix");
  const slug = own(o, "slug");
  const environmentName = own(o, "environmentName");
  if (typeof prefix !== "string" || !PREFIX_RE.test(prefix) || typeof slug !== "string" || !SLUG_RE.test(slug) || typeof environmentName !== "string" || !ENV_NAME_RE.test(environmentName)) {
    throw new CheckFailed([`${label} must name prefix, slug and environmentName.`]);
  }
  return { prefix, slug, environmentName };
}

/** The Entra inputs (`platform provisioning inputs --step entra`). */
export function parseEntraInputs(v: unknown, label = "--inputs"): EntraInputs {
  if (!isObject(v)) throw new CheckFailed([`${label} must be the JSON of "platform provisioning inputs --step entra".`]);
  const roles = rolesOf(own(v, "appRoles"), `${label} appRoles`);
  if (roles.length === 0) throw new CheckFailed([`${label} has no appRoles.`]);
  if (roles.some((r) => r.isEnabled !== undefined)) throw new CheckFailed([`${label} appRoles must not set isEnabled (only the retired roles of --disable-output do).`]);
  const incarnation = own(v, "incarnation");
  if (!Number.isSafeInteger(incarnation) || (incarnation as number) < 0) throw new CheckFailed([`${label} must carry the app's incarnation (an integer >= 0, ADR-0061).`]);
  return { ...identity(v, label), incarnation: incarnation as number, appRoles: roles, roleAssignments: assignmentsOf(own(v, "roleAssignments"), `${label} roleAssignments`), raw: v };
}

/**
 * The platform's assignments and roles that the inputs no longer have, from the record of the last
 * deployment entra-{slug}-{env}. No record: nothing to remove. The record must be of the same
 * instance, app and environment, and of the same incarnation (ADR-0061; a record of a template from
 * before the parameter counts as incarnation 0).
 */
export function entraRemovals(inputs: EntraInputs, recordJson: unknown | undefined): Removals {
  const out: Removals = { prefix: inputs.prefix, slug: inputs.slug, environmentName: inputs.environmentName, assignments: [], roles: [] };
  if (recordJson === undefined) return out;
  const record = parseRecord(recordJson, "--record");
  const p = (name: string): unknown => armValue(record.parameters, name);
  if (p("prefix") !== inputs.prefix || p("slug") !== inputs.slug || p("environmentName") !== inputs.environmentName) {
    throw new CheckFailed(["--record is the deployment of another instance, app or environment than --inputs."]);
  }
  if ((p("incarnation") ?? 0) !== inputs.incarnation) {
    throw new CheckFailed(["--record is the deployment of another incarnation of the slug than --inputs (ADR-0061): the deleted app's registration, not this app's."]);
  }
  const keep = new Set(inputs.roleAssignments.map(key));
  const seen = new Set<string>();
  for (const a of assignmentsOf(p("roleAssignments"), "--record parameter roleAssignments")) {
    const k = key(a);
    if (keep.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.assignments.push(a);
  }
  const values = new Set(inputs.appRoles.map((r) => r.value));
  for (const r of rolesOf(p("appRoles"), "--record parameter appRoles")) {
    if (values.has(r.value) || out.roles.some((x) => x.value === r.value)) continue;
    out.roles.push({ value: r.value, displayName: r.displayName, description: r.description, enabledInRecord: r.isEnabled !== false });
  }
  out.assignments.sort((a, b) => key(a).localeCompare(key(b)));
  out.roles.sort((a, b) => a.value.localeCompare(b.value));
  return out;
}

/** The first deployment's inputs when a retired role is still enabled: final inputs + the retired roles, isEnabled false. */
export function disableInputs(inputs: EntraInputs, removals: Removals): Record<string, unknown> | undefined {
  if (!removals.roles.some((r) => r.enabledInRecord)) return undefined;
  return {
    ...inputs.raw,
    appRoles: [...inputs.appRoles, ...removals.roles.map((r) => ({ value: r.value, displayName: r.displayName, description: r.description, isEnabled: false }))],
  };
}

export function formatRemovals(r: Removals): string {
  const where = `${r.slug} in ${r.environmentName}`;
  if (r.assignments.length === 0 && r.roles.length === 0) return `OK  ${where}: nothing to remove\n`;
  const lines = [
    `OK  ${where}: ${r.assignments.length} role assignment(s) and ${r.roles.length} app role(s) to remove`,
    ...r.assignments.map((a) => `    remove  assignment: principal ${a.principalId}, role ${a.role}`),
    ...r.roles.map((x) => `    remove  app role ${x.value}${x.enabledInRecord ? " (disabled first, then removed)" : " (already disabled; removed)"}`),
  ];
  return lines.join("\n") + "\n";
}

export function parseRemovals(v: unknown, label = "--removals"): Removals {
  if (!isObject(v)) throw new CheckFailed([`${label} must be the output of "platform provisioning entra-removals".`]);
  const roles = own(v, "roles");
  if (!Array.isArray(roles)) throw new CheckFailed([`${label} roles must be an array.`]);
  return {
    ...identity(v, label),
    assignments: assignmentsOf(own(v, "assignments"), `${label} assignments`),
    roles: roles.map((r, i) => {
      const [base] = rolesOf([r], `${label} roles`);
      const enabled = isObject(r) ? own(r, "enabledInRecord") : undefined;
      if (!base || typeof enabled !== "boolean") throw new CheckFailed([`${label} roles[${i}] must carry enabledInRecord.`]);
      return { value: base.value, displayName: base.displayName, description: base.description, enabledInRecord: enabled };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// entra-reconcile: the Graph DELETEs (stage entra).

export interface ReconcileArgs {
  removals: string;
  inputs: string;
  uniqueName: string;
  output: string;
}

export interface ReconcileResult {
  uniqueName: string;
  servicePrincipalId: string;
  removed: { principalId: string; role: string; principalType: string; assignmentId: string }[];
  absent: Assignment[];
}

/** Internal knobs (tests); not CLI flags. */
export interface ReconcileOptions {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

interface Listed {
  id: string;
  appRoleId: string;
  principalId: string;
  principalType: string;
  resourceId: string;
}

function listedOf(doc: unknown): { items: Listed[]; next?: string } {
  const value = isObject(doc) ? own(doc, "value") : undefined;
  if (!Array.isArray(value)) throw new CheckFailed(["GET appRoleAssignedTo did not return a value array."]);
  const items = value.map((x) => {
    const f = (k: string): string => {
      const s = isObject(x) ? own(x, k) : undefined;
      return typeof s === "string" ? s : "";
    };
    return { id: f("id"), appRoleId: f("appRoleId"), principalId: f("principalId"), principalType: f("principalType"), resourceId: f("resourceId") };
  });
  const next = isObject(doc) ? own(doc, "@odata.nextLink") : undefined;
  return { items, ...(typeof next === "string" ? { next } : {}) };
}

/** Assignment IDs are opaque strings (base64url-like); only these characters go into a URL path. */
const ASSIGNMENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export async function entraReconcile(a: ReconcileArgs, env: NodeJS.ProcessEnv, log: (s: string) => void, onClient: (c: Client) => void): Promise<ReconcileResult> {
  const removals = parseRemovals(readJson(a.removals, MiB, "--removals"));
  const inputs = parseEntraInputs(readJson(a.inputs, MiB, "--inputs"));
  const problems: string[] = [];
  if (removals.prefix !== inputs.prefix || removals.slug !== inputs.slug || removals.environmentName !== inputs.environmentName) {
    problems.push("--removals and --inputs name another instance, app or environment.");
  }
  if (!ENTRA_UNIQUE_NAME_RE.test(a.uniqueName) || a.uniqueName !== entraApplicationUniqueName(removals.prefix, removals.slug, removals.environmentName, inputs.incarnation)) {
    problems.push("--unique-name must be the application's uniqueName {prefix}-{slug}-{env}[--i{incarnation}] of --removals and --inputs (names.bicep entraApplicationUniqueName).");
  }
  const keep = new Set(inputs.roleAssignments.map(key));
  if (removals.assignments.some((x) => keep.has(key(x)))) problems.push("--removals lists an assignment that --inputs still declares.");
  let dirOk = false;
  try {
    dirOk = statSync(dirname(resolve(a.output))).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) problems.push("--output must be a file in an existing directory.");
  if (problems.length) throw new CheckFailed(problems);

  const graph = endpoint(env, "SAF_GRAPH_ENDPOINT", DEFAULT_GRAPH);
  const graphToken = token(env, "SAF_GRAPH_TOKEN");
  // Graph only: the ARM side of the shared client is never used (no ARM token, no subscription).
  const client = new Client(graph, graph, "", graphToken, "00000000-0000-0000-0000-000000000000");
  client.graphForbiddenHint =
    " (the Entra provisioning identity needs Application.Read.All to read and AppRoleAssignment.ReadWrite.All to delete, and must own the app registration, ADR-0023)";
  onClient(client);

  // 1. The app's own registration by its uniqueName, never by an ID from the record.
  const appRes = await client.call("graph", client.graphUrl(`v1.0/applications(uniqueName='${a.uniqueName}')`, "?$select=id,appId,uniqueName,appRoles"), "GET", "GET application by uniqueName", undefined, { quote: true });
  const app = appRes.json;
  const appId = isObject(app) ? own(app, "appId") : undefined;
  const uniqueName = isObject(app) ? own(app, "uniqueName") : undefined;
  if (typeof appId !== "string" || !GUID_RE.test(appId) || typeof uniqueName !== "string" || uniqueName.toLowerCase() !== a.uniqueName) {
    throw new CheckFailed([`Graph returned no application with uniqueName ${a.uniqueName}.`]);
  }
  const roleIds = new Map<string, string>();
  const appRoles = isObject(app) ? own(app, "appRoles") : undefined;
  for (const r of Array.isArray(appRoles) ? appRoles : []) {
    const value = isObject(r) ? own(r, "value") : undefined;
    const id = isObject(r) ? own(r, "id") : undefined;
    if (typeof value === "string" && typeof id === "string" && GUID_RE.test(id)) roleIds.set(value, id.toLowerCase());
  }
  // 2. Its service principal.
  const spRes = await client.call("graph", client.graphUrl(`v1.0/servicePrincipals(appId='${appId}')`, "?$select=id,appId"), "GET", "GET service principal", undefined, { quote: true });
  const spId = isObject(spRes.json) ? own(spRes.json, "id") : undefined;
  const spAppId = isObject(spRes.json) ? own(spRes.json, "appId") : undefined;
  if (typeof spId !== "string" || !GUID_RE.test(spId) || typeof spAppId !== "string" || spAppId.toLowerCase() !== appId.toLowerCase()) {
    throw new CheckFailed([`Graph returned no service principal for the application ${a.uniqueName}.`]);
  }
  log(`ok         ${a.uniqueName}: application ${appId}, service principal ${spId}`);

  // 3. Its assignments (all pages, the endpoint's origin only).
  const listed: Listed[] = [];
  let url: URL | undefined = client.graphUrl(`v1.0/servicePrincipals/${spId}/appRoleAssignedTo`, "?$select=id,appRoleId,principalId,principalType,resourceId&$top=999");
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new CheckFailed([`appRoleAssignedTo of ${a.uniqueName} has more than ${MAX_PAGES} pages; not reconciled.`]);
    const r = await client.call("graph", url, "GET", "GET appRoleAssignedTo", undefined, { quote: true });
    const { items, next } = listedOf(r.json);
    listed.push(...items);
    if (next === undefined) {
      url = undefined;
    } else {
      const n = new URL(next);
      if (n.origin !== graph.origin || !n.pathname.toLowerCase().startsWith(`/v1.0/serviceprincipals/${spId.toLowerCase()}/approleassignedto`)) {
        throw new CheckFailed(["Graph returned a next page outside this service principal's assignments; not followed."]);
      }
      url = n;
    }
  }

  // 4. Delete only the planned ones, on this service principal, of a User or Group.
  const result: ReconcileResult = { uniqueName: a.uniqueName, servicePrincipalId: spId, removed: [], absent: [] };
  const failures: string[] = [];
  for (const planned of removals.assignments) {
    const roleId = roleIds.get(planned.role);
    if (!roleId) {
      failures.push(`the application ${a.uniqueName} has no app role ${planned.role}: the assignment of ${planned.principalId} was not removed (remove it by hand, runbook review-app-requests).`);
      continue;
    }
    const matches = listed.filter(
      (x) =>
        x.principalId.toLowerCase() === planned.principalId.toLowerCase() &&
        x.appRoleId.toLowerCase() === roleId &&
        x.resourceId.toLowerCase() === spId.toLowerCase() &&
        (x.principalType === "User" || x.principalType === "Group"),
    );
    if (matches.length === 0) {
      log(`gone       ${planned.role} of ${planned.principalId}: no such assignment (already removed)`);
      result.absent.push(planned);
      continue;
    }
    for (const m of matches) {
      if (!ASSIGNMENT_ID_RE.test(m.id)) {
        failures.push(`Graph listed an assignment of ${planned.principalId} with an unexpected ID; not removed.`);
        continue;
      }
      try {
        const d = await client.call("graph", client.graphUrl(`v1.0/servicePrincipals/${spId}/appRoleAssignedTo/${m.id}`), "DELETE", "DELETE appRoleAssignedTo", undefined, { allow: [404], quote: true });
        log(`${d.status === 404 ? "gone      " : "removed   "} ${planned.role} of ${m.principalType} ${planned.principalId}${d.status === 404 ? " (already removed)" : ""}`);
        result.removed.push({ principalId: planned.principalId, role: planned.role, principalType: m.principalType, assignmentId: m.id });
      } catch (e) {
        failures.push(...messages(e));
      }
    }
  }
  if (failures.length) {
    writeJson(a.output, result);
    throw new CheckFailed(failures);
  }
  return result;
}

export const ENTRA_RECONCILE_HELP = `  entra-removals --inputs <entra inputs json> [--record <entra-{slug}-{env} record>] --output <removals.json>
                 [--disable-output <inputs.json>]
      what the platform assigned and app.yaml no longer lists (ADR-0033, amended 2026-11-11): the
      role assignments and app roles of the record's parameters that --inputs no longer has (no
      --record: none). Writes {prefix, slug, environmentName, assignments: [{principalId, role}],
      roles: [{value, displayName, description, enabledInRecord}]}; --disable-output gets the first
      deployment's inputs (the retired roles with isEnabled false) when a retired role is still
      enabled in the record, else it is removed. Prints one "remove" line per item. Pure
  entra-reconcile --removals <removals.json> --inputs <entra inputs json> --unique-name <prefix-slug-env[--iN]>
                  --output <file>
      deletes the planned role assignments from the app's own service principal (resolved by the
      application's uniqueName; only User and Group assignments of the planned principal and role,
      never one --inputs still declares; an absent one is reported). Token in the environment only:
      SAF_GRAPH_TOKEN; endpoint SAF_GRAPH_ENDPOINT (default public cloud). Writes {uniqueName,
      servicePrincipalId, removed, absent} (also on a failure, exit 1). Calls Microsoft Graph.
`;

/** `platform provisioning entra-removals ...` (sync, pure). */
export function cmdEntraRemovals(v: Record<string, string | undefined>): string {
  const inputs = parseEntraInputs(readJson(v.inputs!, MiB, "--inputs"));
  const record = v.record === undefined ? undefined : readJson(v.record, 16 * MiB, "--record");
  const r = entraRemovals(inputs, record);
  writeJson(v.output!, r);
  const first = disableInputs(inputs, r);
  if (v["disable-output"] !== undefined) {
    if (first) writeJson(v["disable-output"], first);
  }
  return formatRemovals(r);
}

/** `platform provisioning entra-reconcile ...` Exit 0 ok, 1 failed, 2 usage. */
export async function cmdEntraReconcile(args: string[], env: NodeJS.ProcessEnv = process.env, opts: ReconcileOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  let client: Client | undefined;
  const early = [env.SAF_GRAPH_TOKEN].filter((t): t is string => typeof t === "string" && t.length >= 8);
  const clean = (s: string): string => neutralize(client ? client.redact(s) : early.reduce((acc, t) => acc.split(t).join("[redacted]"), s));
  const log = (s: string): void => out(clean(oneLine(s)) + "\n");
  const fail = (lines: string[], code: number): number => {
    for (const l of lines) err(clean(`platform provisioning entra-reconcile: ${oneLine(l)}`) + "\n");
    return code;
  };
  let a: ReconcileArgs;
  try {
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: { removals: { type: "string" }, inputs: { type: "string" }, "unique-name": { type: "string" }, output: { type: "string" } },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    const missing = ["removals", "inputs", "unique-name", "output"].filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    a = { removals: v.removals!, inputs: v.inputs!, uniqueName: v["unique-name"]!, output: v.output! };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([`${msg.slice(0, 300)} Run "platform provisioning help" for usage.`], 2);
  }
  try {
    const r = await entraReconcile(a, env, log, (c) => (client = c));
    writeJson(a.output, r);
    log(`OK  ${r.uniqueName}: ${r.removed.length} role assignment(s) removed, ${r.absent.length} already gone`);
    return 0;
  } catch (e) {
    return fail(messages(e), 1);
  }
}
