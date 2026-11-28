import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, UsageError, isObject, own, writeJson } from "../pipeline/common.js";
import { Client, GUID_RE, endpoint, messages, oneLine, token } from "./easyauth.js";
import { ENTRA_UNIQUE_NAME_RE } from "./names.js";

/**
 * `platform provisioning entra-delete --unique-name <uniqueName> --output <result.json>`
 * (ADR-0056, the delete phase of a decommissioned app, unit `entra` with action delete, stage entra,
 * the Entra provisioning identity's Microsoft Graph token in SAF_GRAPH_TOKEN): deletes the app's own
 * registration, found by its uniqueName (names.bicep entraApplicationUniqueName: {prefix}-{slug}-{env},
 * with --i{incarnation} above incarnation 0), never by an ID from a record or an artifact; then its
 * service principal when Graph still lists it. Gone = done.
 *
 * The guard (hard rule 10): only an application whose uniqueName equals --unique-name exactly;
 * Application.ReadWrite.OwnedBy limits the identity to applications it owns. A deleted application
 * stays in Entra's recycle bin for 30 days and keeps its uniqueName there. It is not purged: the purge
 * (DELETE directory/deletedItems/{id}) answered 403 Authorization_RequestDenied to this identity seconds
 * after the delete (sandbox run 3589) and worked only in a run minutes later (run 3590), so "deleted"
 * would depend on Entra's timing. A new app with the slug has a higher incarnation and so another
 * uniqueName (ADR-0061 section 6). Sandbox run 3589: the DELETE of the
 * application with OwnedBy worked. TODO(verify) DECOM-4: whether the service principal goes with it.
 */

const DEFAULT_GRAPH = "https://graph.microsoft.com/";

export interface EntraDeleteResult {
  uniqueName: string;
  application: "deleted" | "gone";
  appId: string | null;
  servicePrincipal: "deleted" | "gone";
}

export async function entraDelete(a: { uniqueName: string; output: string }, env: NodeJS.ProcessEnv, log: (s: string) => void, onClient: (c: Client) => void): Promise<EntraDeleteResult> {
  const problems: string[] = [];
  if (!ENTRA_UNIQUE_NAME_RE.test(a.uniqueName)) problems.push("--unique-name must be the application's uniqueName {prefix}-{slug}-{env}[--i{incarnation}] (names.bicep entraApplicationUniqueName).");
  let dirOk = false;
  try {
    dirOk = statSync(dirname(resolve(a.output))).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) problems.push("--output must be a file in an existing directory.");
  if (problems.length) throw new CheckFailed(problems);

  const graph = endpoint(env, "SAF_GRAPH_ENDPOINT", DEFAULT_GRAPH);
  const client = new Client(graph, graph, "", token(env, "SAF_GRAPH_TOKEN"), "00000000-0000-0000-0000-000000000000");
  client.graphForbiddenHint = " (the Entra provisioning identity needs Application.ReadWrite.OwnedBy and must own the app registration, ADR-0023)";
  onClient(client);
  const result: EntraDeleteResult = { uniqueName: a.uniqueName, application: "gone", appId: null, servicePrincipal: "gone" };

  const appRes = await client.call("graph", client.graphUrl(`v1.0/applications(uniqueName='${a.uniqueName}')`, "?$select=id,appId,uniqueName"), "GET", "GET application by uniqueName", undefined, { allow: [404], quote: true });
  if (appRes.status !== 404) {
    const app = appRes.json;
    const id = isObject(app) ? own(app, "id") : undefined;
    const appId = isObject(app) ? own(app, "appId") : undefined;
    const uniqueName = isObject(app) ? own(app, "uniqueName") : undefined;
    // The guard: exactly the app's own registration.
    if (typeof id !== "string" || !GUID_RE.test(id) || typeof appId !== "string" || !GUID_RE.test(appId) || typeof uniqueName !== "string" || uniqueName.toLowerCase() !== a.uniqueName) {
      throw new CheckFailed([`Graph returned no application with exactly the uniqueName ${a.uniqueName}; nothing is deleted.`]);
    }
    result.appId = appId;
    const d = await client.call("graph", client.graphUrl(`v1.0/applications/${id}`), "DELETE", "DELETE application", undefined, { allow: [404], quote: true });
    result.application = d.status === 404 ? "gone" : "deleted";
    log(`${result.application === "deleted" ? "deleted   " : "gone      "} application ${a.uniqueName} (${appId})`);
    // Its service principal, when Graph still lists it (TODO(verify) DECOM-4).
    const sp = await client.call("graph", client.graphUrl(`v1.0/servicePrincipals(appId='${appId}')`, "?$select=id,appId"), "GET", "GET service principal", undefined, { allow: [404], quote: true });
    const spId = sp.status === 404 || !isObject(sp.json) ? undefined : own(sp.json, "id");
    const spAppId = sp.status === 404 || !isObject(sp.json) ? undefined : own(sp.json, "appId");
    if (typeof spId === "string" && GUID_RE.test(spId) && typeof spAppId === "string" && spAppId.toLowerCase() === appId.toLowerCase()) {
      const ds = await client.call("graph", client.graphUrl(`v1.0/servicePrincipals/${spId}`), "DELETE", "DELETE service principal", undefined, { allow: [404], quote: true });
      result.servicePrincipal = ds.status === 404 ? "gone" : "deleted";
      log(`${result.servicePrincipal === "deleted" ? "deleted   " : "gone      "} service principal ${spId}`);
    }
  } else {
    log(`gone       application ${a.uniqueName} (already deleted)`);
  }
  return result;
}

export const ENTRA_DELETE_HELP = `  entra-delete --unique-name <prefix-slug-env[--iN]> --output <result.json>
      ADR-0056, the delete phase of a decommissioned app: deletes the application with exactly that
      uniqueName (names.bicep) and its service principal through Microsoft Graph (SAF_GRAPH_TOKEN, the
      Entra provisioning identity: Application.ReadWrite.OwnedBy). Gone = done. The application stays
      in Entra's recycle bin for 30 days, with its uniqueName; a new app with the slug gets another
      one (ADR-0061). Writes { uniqueName, application, appId, servicePrincipal }. Exit 0 ok, 1 failed,
      2 usage
`;

/** `platform provisioning entra-delete ...` Exit 0 ok, 1 failed, 2 usage. */
export async function cmdEntraDelete(args: string[], env: NodeJS.ProcessEnv = process.env, opts: { out?: (s: string) => void; err?: (s: string) => void } = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  let client: Client | undefined;
  const early = [env.SAF_GRAPH_TOKEN].filter((t): t is string => typeof t === "string" && t.length >= 8);
  const clean = (s: string): string => neutralize(client ? client.redact(s) : early.reduce((acc, t) => acc.split(t).join("[redacted]"), s));
  const log = (s: string): void => out(clean(oneLine(s)) + "\n");
  const fail = (lines: string[], code: number): number => {
    for (const l of lines) err(clean(`platform provisioning entra-delete: ${oneLine(l)}`) + "\n");
    return code;
  };
  let a: { uniqueName: string; output: string };
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { "unique-name": { type: "string" }, output: { type: "string" } } });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    const missing = ["unique-name", "output"].filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    a = { uniqueName: v["unique-name"]!, output: v.output! };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([`${msg.slice(0, 300)} Run "platform provisioning help" for usage.`], 2);
  }
  try {
    const r = await entraDelete(a, env, log, (c) => (client = c));
    writeJson(a.output, r);
    log(`OK  ${r.uniqueName}: application ${r.application}, service principal ${r.servicePrincipal}`);
    return 0;
  } catch (e) {
    return fail(messages(e), 1);
  }
}
