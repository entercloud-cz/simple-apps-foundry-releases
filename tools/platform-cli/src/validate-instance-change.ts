import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedNetworkFields } from "./network-change.js";
import { schemaDir } from "./schema.js";
import type { ParsedYaml } from "./schema.js";
import { lineAt, pathOf } from "./validate-app.js";
import type { Finding } from "./validate-app.js";

/**
 * Two rules of `platform validate instance` beyond the file itself (ADR-0027 amendment 2026-11-12):
 *
 * - Warnings (never fail the run): `observability.logRetentionDays` shorter than
 *   `lifecycle.unusedAfterDaysWithoutRequests`. The Lifecycle tab looks for an app's requests in the
 *   environment workspaces (ADR-0054); with shorter logs an unused app can never show as unused.
 *   checkId log-retention-lifecycle (explanations.ts INSTANCE_CHECK_IDS). And
 *   `decommission.allowImmediateWithProduction` true (ADR-0056 amendment 2026-11-21): apps with
 *   production may be deleted immediately, which is for developing the platform, never for a
 *   production deployment. checkId decommission-immediate-with-production.
 * - With `--base` (the target branch of a pull request): the network fields of an environment that an
 *   app uses never change (network-change.ts). checkId environment-network-in-use.
 */

let schema: unknown;
/** A default of config/schema/instance.schema.json by JSON pointer below the root (the dist copy). */
function schemaDefault(pointer: string): unknown {
  schema ??= JSON.parse(readFileSync(join(schemaDir(), "instance.schema.json"), "utf8")) as unknown;
  let node = schema as Record<string, unknown> | undefined;
  for (const part of pointer.split("/")) node = node?.[part] as Record<string, unknown> | undefined;
  return node?.default;
}

export interface InstanceWarningView {
  observability?: { logRetentionDays?: number };
  lifecycle?: { unusedAfterDaysWithoutRequests?: number };
  decommission?: { allowImmediateWithProduction?: boolean };
}

/** What `platform validate instance` reports without failing. */
export function instanceWarnings(inst: InstanceWarningView, parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  const retention = inst.observability?.logRetentionDays ?? (schemaDefault("properties/observability/properties/logRetentionDays") as number);
  const unused = inst.lifecycle?.unusedAfterDaysWithoutRequests ?? (schemaDefault("properties/lifecycle/properties/unusedAfterDaysWithoutRequests") as number);
  if (typeof retention === "number" && typeof unused === "number" && retention < unused) {
    const segs = inst.observability?.logRetentionDays !== undefined ? ["observability", "logRetentionDays"] : ["lifecycle", "unusedAfterDaysWithoutRequests"];
    const line = lineAt(parsed, segs);
    out.push({
      path: pathOf(segs),
      message: `the platform's logs are kept ${retention} days (observability.logRetentionDays), but an app counts as unused only after ${unused} days without requests (lifecycle.unusedAfterDaysWithoutRequests): the Lifecycle tab can never show an unused app. Keep the logs at least ${unused} days.`,
      checkId: "log-retention-lifecycle",
      ...(line !== undefined ? { line } : {}),
    });
  }
  if (inst.decommission?.allowImmediateWithProduction === true) {
    const segs = ["decommission", "allowImmediateWithProduction"];
    const line = lineAt(parsed, segs);
    out.push({
      path: pathOf(segs),
      message:
        "apps with production may be deleted immediately (decommission.allowImmediateWithProduction): this is for developing the platform, not for a production deployment. A merged decommission request with immediate: true then deletes an app's production data and users within the next provisioning runs, without a grace period, and nothing can be cancelled. Set it to false (or remove it) on an instance that runs apps people rely on.",
      checkId: "decommission-immediate-with-production",
      ...(line !== undefined ? { line } : {}),
    });
  }
  return out;
}

export interface EnvironmentNetworkView {
  environments: { name: string; hub?: unknown; networkModes?: unknown }[];
}

/**
 * Against the base version: an environment that `inUse` names keeps every network field. The
 * environment is matched by name; one that is new or gone isn't compared.
 */
export function instanceChangeChecks(base: EnvironmentNetworkView, head: EnvironmentNetworkView, inUse: ReadonlySet<string>, parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  const before = new Map(base.environments.map((e) => [e.name, e]));
  head.environments.forEach((env, i) => {
    const old = before.get(env.name);
    if (!old || !inUse.has(env.name)) return;
    const changed = changedNetworkFields(old, env);
    if (changed.length === 0) return;
    const first = changed[0]!.path.split(".");
    const segs = ["environments", i, ...first];
    const line = lineAt(parsed, segs);
    out.push({
      path: pathOf(["environments", i]),
      message: `${changed.map((f) => f.path).join(", ")} of environment ${env.name} changed, but apps run in ${env.name}: the network of an environment with apps doesn't change (their Container Apps, private endpoints and firewall rules depend on it). Keep the values of the target branch.`,
      checkId: "environment-network-in-use",
      ...(line !== undefined ? { line } : {}),
    });
  });
  return out;
}
