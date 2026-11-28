/**
 * `platform provisioning app-groups` (ADR-0077): the app groups of one app in one environment's kind, kept by the
 * Entra provisioning identity through Microsoft Graph in the stage entra, after the registration is deployed.
 *
 * An app group is a security group per role and environment kind whose members get the role; the app's owner and
 * deputy change its members in the portal (OBO), never the platform. This command:
 *   - finds the app's groups of the kind by their uniqueName ({prefix}-{slug}-{kind}-{role}[--i{incarnation}],
 *     names.ts appGroupUniqueName; GroupMember.Read.All), never by a name anyone could give another group;
 *   - creates a missing one with itself, the owner and the deputy as owners (Group.Create; it can change only the
 *     groups it co-owns, sandbox check ENT-15), renames one whose display name is outdated, and keeps its owners
 *     (users) equal to app.yaml's owner and deputy;
 *   - deletes a group of the app that app.yaml no longer wants (its role left authentication.appGroups);
 *   - assigns each group to its role on the environment's registration (AppRoleAssignment.ReadWrite.All), with
 *     retries while Graph replicates a new group.
 * With --delete (decommissioning, an environment removed) it deletes the kind's groups, unless the app still runs in
 * another environment of that kind. It never adds or removes members.
 */
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, UsageError, isObject, own, writeJson } from "../pipeline/common.js";
import { Client, GUID_RE, HttpError, endpoint, messages, oneLine, token } from "./easyauth.js";
import { appGroupsSpec } from "./inputs.js";
import { instanceEnv, loadAppFile, loadInstanceFile } from "./model.js";
import { ENTRA_UNIQUE_NAME_RE, appGroupDisplayName, appGroupUniqueName, entraApplicationUniqueName } from "./names.js";

const DEFAULT_GRAPH = "https://graph.microsoft.com/";
/** Pages of a Graph list followed at most. */
const MAX_PAGES = 20;
const ASSIGNMENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface AppGroupsArgs {
  instance: string;
  app: string;
  env: string;
  /** The registration's uniqueName (sync only): its service principal gets the assignments. */
  uniqueName?: string;
  output: string;
  delete: boolean;
}

export interface AppGroupsOptions {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Wait between the tries of an assignment while Graph replicates a new group (tests: 0). */
  retryDelayMs?: number;
  /** Tries of an assignment at most. */
  tries?: number;
}

export interface AppGroupState {
  role: string;
  id: string;
  uniqueName: string;
  displayName: string;
  status: "created" | "renamed" | "unchanged";
}

export interface AppGroupsResult {
  slug: string;
  environmentName: string;
  environmentKind: string;
  mode: "sync" | "delete";
  groups: AppGroupState[];
  deleted: { id: string; uniqueName: string }[];
  /** --delete: the groups stay, since the app still runs in these environments of the kind. */
  keptFor: string[];
  ownersAdded: number;
  ownersRemoved: number;
  assigned: number;
  /** Nothing checked: the app has no app groups and the identity can't read groups (no GroupMember.Read.All yet). */
  skipped?: boolean;
}

interface Found {
  id: string;
  uniqueName: string;
  displayName: string;
  description: string;
  /** The role part of the uniqueName (roleToken: lower case, dots as underscores). */
  token: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const roleToken = (role: string): string => role.toLowerCase().replaceAll(".", "_");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The caller's object ID from its access token (claim oid): it names itself as an owner of each group it creates. */
export function callerObjectId(graphToken: string): string {
  const part = graphToken.split(".")[1] ?? "";
  let oid: unknown;
  try {
    oid = own(JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>, "oid");
  } catch {
    oid = undefined;
  }
  if (typeof oid !== "string" || !GUID_RE.test(oid)) throw new CheckFailed(["SAF_GRAPH_TOKEN carries no object ID (claim oid) of the Entra provisioning identity."]);
  return oid.toLowerCase();
}

/** Every page of a Graph list whose next links stay below `path` on the endpoint. */
async function listAll(client: Client, first: URL, path: string, label: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let url: URL | undefined = first;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new CheckFailed([`${label} has more than ${MAX_PAGES} pages.`]);
    const r = await client.call("graph", url, "GET", label, undefined, { quote: true });
    const value = isObject(r.json) ? own(r.json, "value") : undefined;
    if (!Array.isArray(value)) throw new CheckFailed([`${label} did not return a value array.`]);
    items.push(...value.filter(isObject));
    const next = isObject(r.json) ? own(r.json, "@odata.nextLink") : undefined;
    if (typeof next !== "string") {
      url = undefined;
    } else {
      const n = new URL(next);
      if (n.origin !== client.graph.origin || !n.pathname.toLowerCase().startsWith(path.toLowerCase())) {
        throw new CheckFailed([`${label}: Graph returned a next page elsewhere; not followed.`]);
      }
      url = n;
    }
  }
  return items;
}

const str = (o: Record<string, unknown>, k: string): string => {
  const v = own(o, k);
  return typeof v === "string" ? v : "";
};

export async function appGroups(a: AppGroupsArgs, env: NodeJS.ProcessEnv, log: (s: string) => void, onClient: (c: Client) => void, o: AppGroupsOptions = {}): Promise<AppGroupsResult> {
  const inst = loadInstanceFile(a.instance);
  const app = loadAppFile(a.app, a.instance);
  const kind = instanceEnv(inst, a.env).kind;
  const prefix = inst.naming.prefix;
  const incarnation = app.incarnation ?? 0;
  const problems: string[] = [];
  if (!a.delete) {
    if (!Object.hasOwn(app.environments, a.env)) problems.push(`app ${app.slug} does not run in environment ${a.env}.`);
    if (a.uniqueName === undefined || !ENTRA_UNIQUE_NAME_RE.test(a.uniqueName) || a.uniqueName !== entraApplicationUniqueName(prefix, app.slug, a.env, incarnation)) {
      problems.push("--unique-name must be the registration's uniqueName {prefix}-{slug}-{env}[--i{incarnation}] (names.bicep entraApplicationUniqueName).");
    }
  }
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
  const client = new Client(graph, graph, "", graphToken, "00000000-0000-0000-0000-000000000000");
  client.graphForbiddenHint =
    " (the Entra provisioning identity needs Group.Create and GroupMember.Read.All and must still own the app's groups: an Entra admin adds it back as an owner of a group it lost, ADR-0077)";
  onClient(client);
  const self = callerObjectId(graphToken);

  const result: AppGroupsResult = { slug: app.slug, environmentName: a.env, environmentKind: kind, mode: a.delete ? "delete" : "sync", groups: [], deleted: [], keptFor: [], ownersAdded: 0, ownersRemoved: 0, assigned: 0 };

  // 1. The app's groups of the kind, by uniqueName: {prefix}-{slug}-{kind}-{role}[--i{incarnation}] exactly (another
  // app's slug that starts like this one leaves a hyphen in the role part, which no role token has).
  const start = `${prefix}-${app.slug}-${kind}-`;
  const mine = new RegExp(`^${escapeRe(start)}([a-z0-9_]{1,20})${incarnation > 0 ? escapeRe(`--i${incarnation}`) : ""}$`);
  let listed: Record<string, unknown>[];
  try {
    listed = await listAll(
      client,
      client.graphUrl("v1.0/groups", `?$filter=${encodeURIComponent(`startswith(uniqueName,'${start}')`)}&$select=id,uniqueName,displayName,description&$top=999`),
      "/v1.0/groups",
      "GET groups by uniqueName",
    );
  } catch (e) {
    // An instance whose identity team hasn't granted GroupMember.Read.All yet: an app without app groups has nothing to
    // keep (nor to delete: creating them would have needed it), so its run goes on.
    if (e instanceof HttpError && e.status === 403 && (app.authentication.appGroups ?? []).length === 0) {
      log(`skipped    ${app.slug} has no app groups, and this identity can't read groups yet (GroupMember.Read.All, ADR-0077)`);
      result.skipped = true;
      return result;
    }
    throw e;
  }
  const found: Found[] = [];
  for (const g of listed) {
    const id = str(g, "id");
    const uniqueName = str(g, "uniqueName").toLowerCase();
    const m = mine.exec(uniqueName);
    if (!m || !GUID_RE.test(id)) continue;
    found.push({ id: id.toLowerCase(), uniqueName, displayName: str(g, "displayName"), description: str(g, "description"), token: m[1]! });
  }

  const remove = async (g: Found, why: string): Promise<void> => {
    const r = await client.call("graph", client.graphUrl(`v1.0/groups/${g.id}`), "DELETE", "DELETE group", undefined, { allow: [404], quote: true });
    log(`${r.status === 404 ? "gone      " : "deleted   "} ${g.uniqueName} (${why})`);
    result.deleted.push({ id: g.id, uniqueName: g.uniqueName });
  };

  // --delete: the kind's groups go, unless the app still runs in another environment of the kind.
  if (a.delete) {
    const others = app.decommission ? [] : Object.keys(app.environments).filter((e) => e !== a.env && inst.environments.some((x) => x.name === e && x.kind === kind));
    if (others.length) {
      result.keptFor = others;
      log(`kept       ${found.length} app group(s) of ${kind}: ${app.slug} still runs in ${others.join(", ")}`);
      return result;
    }
    for (const g of found) await remove(g, "the app no longer runs in this kind of environment");
    return result;
  }

  const spec = appGroupsSpec(app, inst);
  const want = new Map((spec?.roles ?? []).map((r) => [roleToken(r.value), r] as const));
  for (const g of found) if (!want.has(g.token)) await remove(g, "its role has no app group any more");

  for (const [tok, role] of want) {
    const uniqueName = appGroupUniqueName(prefix, app.slug, kind, role.value, incarnation);
    const displayName = appGroupDisplayName(spec!.namePrefix, app.title, kind, role.displayName);
    const description = groupDescription(kind, app.title, role.value, role.description);
    const g = found.find((x) => x.token === tok);
    if (!g) {
      const id = await create(client, uniqueName, displayName, description, self, spec!.owners);
      log(`created    ${uniqueName}: "${displayName}", owners the owner and the deputy`);
      result.groups.push({ role: role.value, id, uniqueName, displayName, status: "created" });
      continue;
    }
    let status: AppGroupState["status"] = "unchanged";
    if (g.displayName !== displayName || g.description !== description) {
      const patch = { ...(g.displayName !== displayName ? { displayName } : {}), ...(g.description !== description ? { description } : {}) };
      await client.call("graph", client.graphUrl(`v1.0/groups/${g.id}`), "PATCH", "PATCH group name and description", patch, { quote: true });
      log(`${g.displayName !== displayName ? "renamed   " : "described "} ${uniqueName}: "${displayName}"`);
      status = "renamed";
    }
    const { added, removed } = await syncOwners(client, g.id, spec!.owners);
    if (added || removed) log(`owners     ${uniqueName}: ${added} added, ${removed} removed (app.yaml owner and deputy)`);
    result.ownersAdded += added;
    result.ownersRemoved += removed;
    result.groups.push({ role: role.value, id: g.id, uniqueName, displayName, status });
  }

  if (result.groups.length) result.assigned = await assign(client, a.uniqueName!, result.groups, log, o);
  return result;
}

/** Creates the group with the caller, the owner and the deputy as owners; its object ID. */
/**
 * An app group's description: who its members are, what the role may do (the app's or the default role's
 * description, roles.ts), and that its owners manage the members in the portal. At most 1024 characters.
 */
export function groupDescription(kind: string, title: string, role: string, roleDescription: string | undefined): string {
  const what = roleDescription?.trim() ? ` ${roleDescription.trim().replace(/\s+/g, " ")}${/[.!?]$/.test(roleDescription.trim()) ? "" : "."}` : "";
  return `${kind === "prod" ? "Production" : "Non-production"} users of ${title} with the role ${role}.${what} Its owners manage the members in the portal.`.slice(0, 1024);
}

async function create(client: Client, uniqueName: string, displayName: string, description: string, self: string, owners: string[]): Promise<string> {
  const body = {
    displayName,
    description,
    mailEnabled: false,
    mailNickname: uniqueName,
    securityEnabled: true,
    uniqueName,
    "owners@odata.bind": [client.graphUrl(`v1.0/servicePrincipals/${self}`).toString(), ...owners.map((id) => client.graphUrl(`v1.0/users/${id}`).toString())],
  };
  const r = await client.call("graph", client.graphUrl("v1.0/groups"), "POST", "POST group", body, { quote: true });
  const id = isObject(r.json) ? own(r.json, "id") : undefined;
  if (typeof id !== "string" || !GUID_RE.test(id)) throw new CheckFailed([`Graph created ${uniqueName} but returned no object ID.`]);
  return id.toLowerCase();
}

/** The group's user owners made equal to `want` (the caller itself, a service principal, is never listed or touched). */
async function syncOwners(client: Client, groupId: string, want: string[]): Promise<{ added: number; removed: number }> {
  const path = `/v1.0/groups/${groupId}/owners`;
  const listed = await listAll(client, client.graphUrl(`v1.0/groups/${groupId}/owners/microsoft.graph.user`, "?$select=id&$top=999"), path, "GET group owners");
  const have = new Set(listed.map((x) => str(x, "id").toLowerCase()).filter((id) => GUID_RE.test(id)));
  let added = 0;
  let removed = 0;
  for (const id of want) {
    if (have.has(id)) continue;
    try {
      await client.call("graph", client.graphUrl(`v1.0/groups/${groupId}/owners/$ref`), "POST", "POST group owner", { "@odata.id": client.graphUrl(`v1.0/directoryObjects/${id}`).toString() }, { quote: true });
      added++;
    } catch (e) {
      // Already an owner (Graph's replica lagged behind the list): the state wanted.
      if (!(e instanceof HttpError && e.status === 400 && e.problems.some((p) => /already exist/i.test(p)))) throw e;
    }
  }
  for (const id of have) {
    if (want.includes(id)) continue;
    const r = await client.call("graph", client.graphUrl(`v1.0/groups/${groupId}/owners/${id}/$ref`), "DELETE", "DELETE group owner", undefined, { allow: [404], quote: true });
    if (r.status !== 404) removed++;
  }
  return { added, removed };
}

/** Each group assigned to its role on the registration's service principal; the number of new assignments. */
async function assign(client: Client, uniqueName: string, groups: AppGroupState[], log: (s: string) => void, o: AppGroupsOptions): Promise<number> {
  const appRes = await client.call("graph", client.graphUrl(`v1.0/applications(uniqueName='${uniqueName}')`, "?$select=id,appId,uniqueName,appRoles"), "GET", "GET application by uniqueName", undefined, { allow: [404], quote: true });
  const appId = isObject(appRes.json) ? own(appRes.json, "appId") : undefined;
  if (appRes.status === 404 || typeof appId !== "string" || !GUID_RE.test(appId)) throw new CheckFailed([`the registration ${uniqueName} doesn't exist (yet): its app groups are assigned after it is deployed.`]);
  const roleIds = new Map<string, string>();
  const appRoles = isObject(appRes.json) ? own(appRes.json, "appRoles") : undefined;
  for (const r of Array.isArray(appRoles) ? appRoles.filter(isObject) : []) {
    if (own(r, "isEnabled") === false) continue;
    const id = str(r, "id");
    if (GUID_RE.test(id)) roleIds.set(str(r, "value"), id.toLowerCase());
  }
  const spRes = await client.call("graph", client.graphUrl(`v1.0/servicePrincipals(appId='${appId}')`, "?$select=id,appId"), "GET", "GET service principal", undefined, { quote: true });
  const spId = isObject(spRes.json) ? str(spRes.json, "id").toLowerCase() : "";
  if (!GUID_RE.test(spId)) throw new CheckFailed([`Graph returned no service principal for the registration ${uniqueName}.`]);
  const listed = await listAll(
    client,
    client.graphUrl(`v1.0/servicePrincipals/${spId}/appRoleAssignedTo`, "?$select=id,appRoleId,principalId,principalType,resourceId&$top=999"),
    `/v1.0/servicePrincipals/${spId}/appRoleAssignedTo`,
    "GET appRoleAssignedTo",
  );
  const tries = Math.max(1, o.tries ?? 12);
  const delay = o.retryDelayMs ?? 10_000;
  let made = 0;
  const failures: string[] = [];
  for (const g of groups) {
    const roleId = roleIds.get(g.role);
    if (!roleId) {
      failures.push(`the registration ${uniqueName} has no enabled app role ${g.role}: its app group ${g.uniqueName} was not assigned.`);
      continue;
    }
    const assigned = listed.some((x) => str(x, "principalId").toLowerCase() === g.id && str(x, "appRoleId").toLowerCase() === roleId && ASSIGNMENT_ID_RE.test(str(x, "id")));
    if (assigned) continue;
    for (let i = 1; ; i++) {
      try {
        await client.call("graph", client.graphUrl(`v1.0/servicePrincipals/${spId}/appRoleAssignedTo`), "POST", "POST appRoleAssignedTo", { principalId: g.id, resourceId: spId, appRoleId: roleId }, { quote: true });
        log(`assigned   ${g.uniqueName} to the role ${g.role} of ${uniqueName}`);
        made++;
        break;
      } catch (e) {
        // A group Graph has just created may not be visible to the assignment yet (400/404): wait and try again.
        const replicating = e instanceof HttpError && (e.status === 400 || e.status === 404) && i < tries;
        if (!replicating) {
          failures.push(...messages(e));
          break;
        }
        log(`waiting    ${g.uniqueName}: Graph doesn't see the new group yet (try ${i} of ${tries})`);
        await sleep(delay);
      }
    }
  }
  if (failures.length) throw new CheckFailed(failures);
  return made;
}

export const APP_GROUPS_HELP = `  app-groups --instance <instance.yaml> --app <app.yaml> --env <env> --unique-name <prefix-slug-env[--iN]>
             --output <file> | --delete
      keeps the app groups of the environment's kind (ADR-0077): finds the app's groups by uniqueName
      {prefix}-{slug}-{kind}-{role}[--i{incarnation}], creates a missing one (owners: itself, app.yaml's owner and
      deputy), renames an outdated one, keeps its user owners equal to the owner and the deputy, deletes one whose
      role has no app group any more, and assigns each to its role on the registration --unique-name. --delete
      (decommissioning, an environment removed) deletes the kind's groups unless the app still runs in another
      environment of the kind. Never changes members. Token in the environment only: SAF_GRAPH_TOKEN; endpoint
      SAF_GRAPH_ENDPOINT (default public cloud). Writes {slug, environmentName, environmentKind, mode, groups,
      deleted, keptFor, ownersAdded, ownersRemoved, assigned}; exit 1 on a failure. Calls Microsoft Graph.
`;

/** `platform provisioning app-groups ...` Exit 0 ok, 1 failed, 2 usage. */
export async function cmdAppGroups(args: string[], env: NodeJS.ProcessEnv = process.env, opts: AppGroupsOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  let client: Client | undefined;
  const early = [env.SAF_GRAPH_TOKEN].filter((t): t is string => typeof t === "string" && t.length >= 8);
  const clean = (s: string): string => neutralize(client ? client.redact(s) : early.reduce((acc, t) => acc.split(t).join("[redacted]"), s));
  const log = (s: string): void => out(clean(oneLine(s)) + "\n");
  const fail = (lines: string[], code: number): number => {
    for (const l of lines) err(clean(`platform provisioning app-groups: ${oneLine(l)}`) + "\n");
    return code;
  };
  let a: AppGroupsArgs;
  try {
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: { instance: { type: "string" }, app: { type: "string" }, env: { type: "string" }, "unique-name": { type: "string" }, output: { type: "string" }, delete: { type: "boolean" } },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | boolean | undefined>;
    const missing = ["instance", "app", "env", "output", ...(v.delete ? [] : ["unique-name"])].filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    a = { instance: v.instance as string, app: v.app as string, env: v.env as string, uniqueName: v["unique-name"] as string | undefined, output: v.output as string, delete: v.delete === true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([`${msg.slice(0, 300)} Run "platform provisioning help" for usage.`], 2);
  }
  try {
    const r = await appGroups(a, env, log, (c) => (client = c), opts);
    writeJson(a.output, r);
    if (r.mode === "delete") {
      log(r.keptFor.length ? `OK  ${r.slug}: the app groups of ${r.environmentKind} stay (${r.keptFor.join(", ")})` : `OK  ${r.slug}: ${r.deleted.length} app group(s) of ${r.environmentKind} deleted`);
    } else {
      const n = (s: AppGroupState["status"]): number => r.groups.filter((g) => g.status === s).length;
      log(`OK  ${r.slug} in ${r.environmentName}: ${r.groups.length} app group(s) (${n("created")} created, ${n("renamed")} renamed), ${r.deleted.length} deleted, ${r.assigned} assignment(s) made, owners ${r.ownersAdded} added and ${r.ownersRemoved} removed`);
    }
    return 0;
  } catch (e) {
    return fail(messages(e), 1);
  }
}
