import { CheckFailed, MiB, isObject, own, readText, writeJson } from "../pipeline/common.js";
import { parseYaml } from "../schema.js";
import { entraChangesMode, loadInstanceFile } from "./model.js";
import type { EntraChanges } from "./model.js";

/**
 * `platform provisioning entra-effect --base <app.yaml|none> --head <app.yaml|none> [--instance <instance.yaml>]
 * [--output <effect.json>]` (ADR-0051): what a change of an app definition does in Entra, for the
 * reviewers of a platform-config pull request, whose approval is the approval of those changes with
 * approvals.entraChanges pullRequest. Pure and offline: two files in, text (and JSON) out; no Azure,
 * no credentials. `none` stands for a file that doesn't exist on that side (a new app, a removed one).
 *
 * The files are read as YAML, not validated (`platform validate app` does that): only what the
 * stage entra deploys from them is compared (infra/entra/app-registration.bicep inputs):
 *   - sign-in (authentication.mode required) turned on or off;
 *   - environments with sign-in added or removed (one registration each);
 *   - role assignments (role, principalType, objectId) added or removed;
 *   - the app's own app roles (authentication.roles, by value) added or removed;
 *   - custom hosts (environments.{env}.frontDoor.hostName) of an app with sign-in: redirect URIs.
 */

export interface EntraEffect {
  slug: string;
  /** approvals.entraChanges of --instance, when given. */
  entraChanges?: EntraChanges;
  signIn: { before: boolean; after: boolean };
  environments: { added: string[]; removed: string[] };
  assignments: { added: Assignment[]; removed: Assignment[] };
  roles: { added: string[]; removed: string[] };
  /** ADR-0077: roles whose app group is added or removed (a group per environment kind, created or deleted). */
  appGroups: { added: string[]; removed: string[] };
  /** ADR-0077: the owners of the app groups change (app.yaml owner or deputy), when the app has app groups. */
  appGroupOwners: boolean;
  /** Redirect URIs that change: per environment the custom host before and after (absent: the default host). */
  hosts: { environment: string; before?: string; after?: string }[];
  /** Anything at all changes in Entra. */
  changes: boolean;
}

export interface Assignment {
  role: string;
  principalType: string;
  objectId: string;
  displayName?: string;
}

interface Side {
  slug?: string;
  signIn: boolean;
  environments: string[];
  assignments: Assignment[];
  roles: string[];
  appGroups: string[];
  /** owner and deputy object IDs (they own the app groups). */
  owners: string[];
  hosts: Record<string, string>;
}

const NONE: Side = { signIn: false, environments: [], assignments: [], roles: [], appGroups: [], owners: [], hosts: {} };

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The Entra-relevant part of an app definition's parsed YAML. */
export function entraSide(doc: unknown, label: string): Side {
  if (!isObject(doc)) throw new CheckFailed([`${label} is not a YAML mapping (an app definition).`]);
  const auth = isObject(own(doc, "authentication")) ? (own(doc, "authentication") as Record<string, unknown>) : {};
  const envs = isObject(own(doc, "environments")) ? (own(doc, "environments") as Record<string, unknown>) : {};
  const assignments = (Array.isArray(own(auth, "assignments")) ? (own(auth, "assignments") as unknown[]) : []).flatMap((a): Assignment[] => {
    if (!isObject(a)) return [];
    const role = str(own(a, "role"));
    const principalType = str(own(a, "principalType"));
    const objectId = str(own(a, "objectId"));
    const displayName = str(own(a, "displayName"));
    return role && principalType && objectId ? [{ role, principalType, objectId: objectId.toLowerCase(), ...(displayName ? { displayName } : {}) }] : [];
  });
  const roles = (Array.isArray(own(auth, "roles")) ? (own(auth, "roles") as unknown[]) : []).flatMap((r) => (isObject(r) && str(own(r, "value")) ? [str(own(r, "value"))!] : []));
  const hosts: Record<string, string> = {};
  for (const [name, e] of Object.entries(envs)) {
    const fd = isObject(e) ? own(e, "frontDoor") : undefined;
    const host = isObject(fd) ? str(own(fd, "hostName")) : undefined;
    if (host) hosts[name] = host.toLowerCase();
  }
  const slug = str(own(doc, "slug"));
  const appGroups = (Array.isArray(own(auth, "appGroups")) ? (own(auth, "appGroups") as unknown[]) : []).flatMap((r) => (str(r) ? [str(r)!] : []));
  const person = (k: string): string[] => {
    const p = own(doc, k);
    const id = isObject(p) ? str(own(p, "objectId")) : undefined;
    return id ? [id.toLowerCase()] : [];
  };
  return {
    ...(slug ? { slug } : {}),
    signIn: own(auth, "mode") === "required",
    environments: Object.keys(envs).sort(),
    assignments,
    roles: [...new Set(roles)].sort(),
    appGroups: [...new Set(appGroups)].sort(),
    owners: [...person("owner"), ...person("deputy")],
    hosts,
  };
}

function readSide(path: string, label: string): Side {
  if (path === "none") return NONE;
  const parsed = parseYaml(readText(path, MiB, label));
  if (parsed.parseErrors.length) throw new CheckFailed(parsed.parseErrors.map((e) => `${label} line ${e.line}: ${e.message}`));
  return entraSide(parsed.data, label);
}

const key = (a: Assignment): string => `${a.role}|${a.principalType}|${a.objectId}`;

/** The Entra effect of going from `base` to `head` (pure). */
export function entraEffect(base: Side, head: Side, entraChanges?: EntraChanges): EntraEffect {
  const slug = head.slug ?? base.slug ?? "";
  // What Entra holds on each side: nothing for an app without sign-in.
  const b = base.signIn ? base : NONE;
  const h = head.signIn ? head : NONE;
  const minus = <T>(x: T[], y: T[], k: (v: T) => string): T[] => x.filter((v) => !y.some((w) => k(w) === k(v)));
  const id = (s: string): string => s;
  const hosts: EntraEffect["hosts"] = [];
  for (const env of [...new Set([...Object.keys(b.hosts), ...Object.keys(h.hosts)])].sort()) {
    // A host of an environment added or removed with its registration is part of that registration.
    if (!b.environments.includes(env) || !h.environments.includes(env)) continue;
    if (b.hosts[env] !== h.hosts[env]) hosts.push({ environment: env, ...(b.hosts[env] ? { before: b.hosts[env] } : {}), ...(h.hosts[env] ? { after: h.hosts[env] } : {}) });
  }
  const e: EntraEffect = {
    slug,
    ...(entraChanges ? { entraChanges } : {}),
    signIn: { before: base.signIn, after: head.signIn },
    environments: { added: minus(h.environments, b.environments, id), removed: minus(b.environments, h.environments, id) },
    assignments: { added: minus(h.assignments, b.assignments, key), removed: minus(b.assignments, h.assignments, key) },
    roles: { added: minus(h.roles, b.roles, id), removed: minus(b.roles, h.roles, id) },
    appGroups: { added: minus(h.appGroups, b.appGroups, id), removed: minus(b.appGroups, h.appGroups, id) },
    appGroupOwners: b.appGroups.length > 0 && h.appGroups.length > 0 && [...b.owners].sort().join() !== [...h.owners].sort().join(),
    hosts,
    changes: false,
  };
  e.changes =
    e.signIn.before !== e.signIn.after ||
    e.appGroupOwners ||
    e.environments.added.length + e.environments.removed.length + e.assignments.added.length + e.assignments.removed.length + e.roles.added.length + e.roles.removed.length + e.appGroups.added.length + e.appGroups.removed.length + e.hosts.length > 0;
  return e;
}

const who = (a: Assignment): string => `${a.principalType === "Group" ? "group" : "user"} ${a.displayName ? `${a.displayName} (${a.objectId})` : a.objectId}`;

export function formatEntraEffect(e: EntraEffect): string {
  const head = `Entra effect of apps/${e.slug}/app.yaml`;
  if (!e.changes) return `${head}: no Entra change.\n`;
  const how =
    e.entraChanges === "pullRequest"
      ? " (approvals.entraChanges: pullRequest: merging this pull request applies it without a further approval)"
      : e.entraChanges === "separate"
        ? " (approvals.entraChanges: separate: the stage entra waits for its own approval after the merge)"
        : "";
  const lines = [`${head}${how}:`];
  if (!e.signIn.before && e.signIn.after) lines.push(`  sign-in turned on: a registration in ${e.environments.added.join(", ") || "every environment"}, with a sign-in secret`);
  else if (e.signIn.before && !e.signIn.after) lines.push(`  sign-in turned off: the registrations stay until removed by hand (${e.environments.removed.join(", ")})`);
  else {
    for (const env of e.environments.added) lines.push(`  + registration in ${env}, with a sign-in secret`);
    for (const env of e.environments.removed) lines.push(`  - environment ${env}: its registration stays until removed by hand`);
  }
  for (const a of e.assignments.added) lines.push(`  + role ${a.role}: ${who(a)}`);
  for (const a of e.assignments.removed) lines.push(`  - role ${a.role}: ${who(a)}`);
  for (const r of e.appGroups.added) lines.push(`  + app group for the role ${r}: one per environment kind, its members managed by the owner and the deputy in the portal`);
  for (const r of e.appGroups.removed) lines.push(`  - app group for the role ${r}: the groups are deleted, their members lose the role`);
  if (e.appGroupOwners) lines.push("  owners of the app groups: the new owner and deputy (the previous ones are removed)");
  for (const r of e.roles.added) lines.push(`  + app role ${r}`);
  for (const r of e.roles.removed) lines.push(`  - app role ${r} (disabled, then removed)`);
  for (const x of e.hosts) lines.push(`  redirect URI in ${x.environment}: ${x.before ?? "the default host"} -> ${x.after ?? "the default host"}`);
  return lines.join("\n") + "\n";
}

export const ENTRA_EFFECT_HELP = `  entra-effect --base <app.yaml|none> --head <app.yaml|none> [--instance <instance.yaml>] [--output <effect.json>]
      what a change of an app definition does in Entra (ADR-0051), for the reviewers of a
      platform-config pull request: sign-in on or off, registrations of environments added or
      removed, role assignments, app groups (ADR-0077) and app roles added or removed, the app groups'
      owners, redirect URIs of custom hosts. "none"
      for a side without the file (a new app). --instance adds how the change is approved
      (approvals.entraChanges). Pure: no Azure, no credentials; the files are read, not validated
`;

/** `platform provisioning entra-effect ...` (sync, pure). */
export function cmdEntraEffect(v: Record<string, string | undefined>): string {
  const mode = v.instance !== undefined ? entraChangesMode(loadInstanceFile(v.instance)) : undefined;
  const e = entraEffect(readSide(v.base!, "--base"), readSide(v.head!, "--head"), mode);
  if (v.output !== undefined) writeJson(v.output, e);
  return formatEntraEffect(e);
}
