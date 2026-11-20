import { writeFileSync } from "node:fs";
import { isMap, isPair, isScalar, parseDocument } from "yaml";
import { CheckFailed, MiB, UsageError, own, readText } from "../pipeline/common.js";
import { provisioningHostEnvironment } from "../provisioning/generate.js";
import { parseInstanceText } from "../provisioning/model.js";
import type { Instance } from "../provisioning/model.js";
import { portalDeployment, portalEntraDeployment } from "../provisioning/names.js";
import { portalHost } from "../environment/portal-host.js";
import { bootstrapDeployment } from "./facts.js";
import { loadState } from "./inputs.js";
import type { InstanceState, StateFiles } from "./inputs.js";

/**
 * `platform instance sync` (ADR-0066 decision 5): the values instance.yaml takes from the instance's
 * state, for the pull request that records them:
 *
 *   identities.entraProvisioningPrincipalId  the host's bootstrap output entraProvisioningIdentity.principalId
 *   portal.identityPrincipalId               the host's bootstrap output portalIdentity.principalId
 *   portal.clientId                          the registration's output clientId (entra-portal-{host})
 *   portal.apiBaseUrl                        https:// + the portal's own host name through Front Door
 *                                            (ADR-0071), known from instance.yaml before any portal
 *                                            deployment; without one the portal deployment's output portalUrl
 *                                            (portal-{prefix}-{host}; https:// + portalFqdn from deployments
 *                                            before portalUrl). Only while it is not set or is still the
 *                                            Container App's address: another value set by hand is kept
 *
 * Without --write it only says what would change. With --write it edits the file in place and keeps
 * everything else byte for byte (comments, alignment, quoting): an existing value is replaced in the
 * source text, a missing key is added as the first entry of its section (a missing section at the end).
 * The result must still pass the schema, else nothing is written. GUIDs compare case-insensitively.
 */

type Path = [string, string];

export interface SyncChange {
  path: string;
  from: string | null;
  to: string | null;
  /** Why `to` is null: the state doesn't have the value yet. */
  missing?: string;
  /** A fill-only value instance.yaml already has: what sync would have written (`to` is `from`). */
  kept?: string;
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The value instance.yaml has at a two-level path, as text, or null. */
function current(text: string, path: Path): string | null {
  const v = parseDocument(text).getIn(path);
  return v === undefined || v === null ? null : String(v);
}

/** Sets a two-level scalar, editing only the source text it touches. */
export function setScalar(text: string, path: Path, value: string): string {
  const doc = parseDocument(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const node = doc.getIn(path, true);
  let out: string | undefined;
  if (isScalar(node) && node.range && node.range[1] > node.range[0]) {
    const [start, end] = node.range;
    const q = node.type === "QUOTE_DOUBLE" ? '"' : node.type === "QUOTE_SINGLE" ? "'" : "";
    out = text.slice(0, start) + q + value + q + text.slice(end);
  } else if (node === undefined && isMap(doc.contents)) {
    const pair = doc.contents.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === path[0]);
    const parent = pair?.value;
    if (!pair) {
      const base = text.length === 0 || text.endsWith("\n") ? text : text + eol;
      out = `${base}${path[0]}:${eol}  ${path[1]}: ${value}${eol}`;
    } else if (isMap(parent) && !parent.flow && parent.items.length > 0 && isScalar(pair.key) && pair.key.range) {
      const first = parent.items[0]!.key;
      const lineEnd = text.indexOf("\n", pair.key.range[1]);
      if (isScalar(first) && first.range && lineEnd >= 0) {
        const indent = first.range[0] - (text.lastIndexOf("\n", first.range[0] - 1) + 1);
        out = `${text.slice(0, lineEnd + 1)}${" ".repeat(indent)}${path[1]}: ${value}${eol}${text.slice(lineEnd + 1)}`;
      }
    }
  }
  if (out === undefined) {
    // A shape the edit above doesn't handle (a flow or empty section, an empty value): the document API,
    // which keeps the comments but may realign them.
    doc.setIn(path, value);
    out = doc.toString({ lineWidth: 0 });
  }
  if (current(out, path) !== value) throw new Error(`instance sync: setting ${path.join(".")} did not take.`);
  return out;
}

export function syncChanges(inst: Instance, text: string, state: InstanceState): SyncChange[] {
  const host = provisioningHostEnvironment(inst);
  const outputs = Object.hasOwn(state.outputs, host) ? state.outputs[host] : undefined;
  if (!outputs) throw new CheckFailed([`sync needs the bootstrap outputs of the portal host environment ${host} (--outputs ${host}=<file>, deployment ${bootstrapDeployment(inst.naming.prefix, host)}).`]);
  const registration = state.registration ? own(state.registration, "clientId") : undefined;
  if (state.registration && (typeof registration !== "string" || !GUID_RE.test(registration))) {
    throw new CheckFailed([`--registration has no clientId (a GUID): it must be the outputs of ${portalEntraDeployment(host)}.`]);
  }
  const fqdn = state.portal ? own(state.portal, "portalFqdn") : undefined;
  if (state.portal && (typeof fqdn !== "string" || !fqdn.trim())) {
    throw new CheckFailed([`--portal-outputs has no portalFqdn: it must be the outputs of ${portalDeployment(inst.naming.prefix, host)}.`]);
  }
  const containerAppUrl = typeof fqdn === "string" ? `https://${fqdn.trim().toLowerCase()}` : undefined;
  const portalUrl = state.portal ? own(state.portal, "portalUrl") : undefined;
  const ownHostName = portalHost(inst).host.hostName;
  const publicUrl = ownHostName ? `https://${ownHostName}` : typeof portalUrl === "string" && portalUrl.trim() ? portalUrl.trim().toLowerCase() : containerAppUrl;
  const wanted: { path: Path; value: string | undefined; missing: string; fillOnly?: boolean; replaces?: string }[] = [
    {
      path: ["identities", "entraProvisioningPrincipalId"],
      value: outputs.entraProvisioningIdentity?.principalId,
      missing: `the bootstrap outputs of ${host} have no entraProvisioningIdentity (run its bootstrap with this core version)`,
    },
    {
      path: ["portal", "identityPrincipalId"],
      value: outputs.portalIdentity?.principalId,
      missing: `the bootstrap outputs of ${host} have no portalIdentity (run its bootstrap with this core version)`,
    },
    {
      path: ["portal", "clientId"],
      value: typeof registration === "string" ? registration : undefined,
      missing: `no portal registration yet (deployment ${portalEntraDeployment(host)}, --registration)`,
    },
    {
      path: ["portal", "apiBaseUrl"],
      value: publicUrl,
      missing: `no portal deployment yet (deployment ${portalDeployment(inst.naming.prefix, host)}, --portal-outputs)`,
      fillOnly: true,
      // The Container App's own address is what sync wrote before the portal had a host name of its own.
      ...(containerAppUrl ? { replaces: containerAppUrl } : {}),
    },
  ];
  return wanted.map((w) => {
    const from = current(text, w.path);
    const to = w.value === undefined ? null : w.value.toLowerCase();
    if (w.fillOnly && from !== null && to !== null && from.toLowerCase() !== w.replaces) return { path: w.path.join("."), from, to: from, kept: to };
    return { path: w.path.join("."), from, to, ...(to === null ? { missing: w.missing } : {}) };
  });
}

const changed = (c: SyncChange): boolean => c.to !== null && (c.from ?? "").toLowerCase() !== c.to;

export function formatSync(file: string, changes: SyncChange[], written: boolean): string {
  const lines = [`platform instance sync: ${file}`];
  const width = Math.max(...changes.map((c) => c.path.length));
  for (const c of changes) {
    const label = `  ${c.path.padEnd(width)}  `;
    if (c.to === null) lines.push(`${label}not available: ${c.missing ?? "no value"}${c.from ? ` (keeps ${c.from})` : ""}`);
    else if (c.kept !== undefined && c.kept !== (c.from ?? "").toLowerCase()) lines.push(`${label}kept ${c.from} (set by hand; the portal's own host name is ${c.kept})`);
    else if (!changed(c)) lines.push(`${label}unchanged (${c.from ?? ""})`);
    else lines.push(`${label}${c.from ?? "(not set)"} -> ${c.to}`);
  }
  const n = changes.filter(changed).length;
  if (n === 0) lines.push("OK  instance.yaml already has these values.");
  else if (written) lines.push(`${n} value${n === 1 ? "" : "s"} written to ${file}: commit it in a pull request to platform-config.`);
  else lines.push(`${n} value${n === 1 ? "" : "s"} would change: write ${n === 1 ? "it" : "them"} with --write (instance.sh sync --apply), then commit instance.yaml in a pull request.`);
  return lines.join("\n") + "\n";
}

export function instanceSyncFiles(args: { instance: string; write: boolean } & StateFiles): string {
  if (args.federation !== undefined || args.platformOutputs !== undefined) {
    throw new UsageError("sync takes --outputs, --registration and --portal-outputs only.");
  }
  const text = readText(args.instance, 4 * MiB, "instance.yaml");
  const inst = parseInstanceText(text);
  const changes = syncChanges(inst, text, loadState(inst, args));
  let next = text;
  for (const c of changes) if (changed(c)) next = setScalar(next, c.path.split(".") as Path, c.to!);
  if (next !== text) {
    try {
      parseInstanceText(next);
    } catch (e) {
      if (e instanceof CheckFailed) throw new CheckFailed(["the synced instance.yaml would not be valid, nothing written:", ...e.problems]);
      throw e;
    }
    if (args.write) writeFileSync(args.instance, next, "utf8");
  }
  return formatSync(args.instance, changes, args.write && next !== text);
}
