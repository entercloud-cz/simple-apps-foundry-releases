import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * A fake ARM (one platform job, its operations and executions) and Microsoft Graph (one app
 * registration) for `platform provisioning easyauth-secret` and `dbinit`, on one loopback origin: ARM paths
 * start with /subscriptions/, Graph paths with /v1.0/. Every request is recorded.
 *
 * The job behaves like the real one as far as the command can tell: a PATCH replaces
 * configuration.secrets (JSON merge patch), GET lists secret names only, a start resolves the
 * template's secretRef against the job secrets and "writes the vault" (vaultWrites) when the
 * execution succeeds. The shapes follow the Container Apps REST API 2024-03-01 documentation;
 * no sandbox response exists yet (JOB-3, JOB-4).
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SUB = "00000000-0000-0000-0000-0000000000b1";
export const RG = "rg-contoso-platform-dev";
export const JOB = "caj-contoso-kvset-ext";
export const JOB_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${JOB}`;
export const VAULT = "kvcontosodevp1a2b3";
export const CLIENT_ID = "00000000-0000-0000-0000-0000000000c1";
export const APP_OID = "00000000-0000-0000-0000-0000000000c2";
export const KEY_ID = "00000000-0000-0000-0000-0000000000c3";
export const KVSET_CLIENT_ID = "00000000-0000-0000-0000-0000000000c4";
export const IMAGE = `crcontosodev.azurecr.io/saf-jobs@sha256:${"ab".repeat(32)}`;
export const DBINIT_JOB = "caj-contoso-dbinit-ext";
export const DBINIT_JOB_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${DBINIT_JOB}`;
export const DBINIT_CLIENT_ID = "00000000-0000-0000-0000-0000000000c6";
// Assembled at run time, so no secret-shaped literal sits in the repo.
export const ARM_TOKEN = ["fake", "arm", "token", "a".repeat(24)].join("-");
export const GRAPH_TOKEN = ["fake", "graph", "token", "g".repeat(24)].join("-");
export const VALUE = ["easyauth", "test", randomBytes(16).toString("hex")].join("~");
/** The hint Graph lists for an existing password (its first characters): never printed either. */
export const HINT = ["hint", randomBytes(3).toString("hex")].join("~");

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  raw: string;
}

export function kvsetJob(): J {
  return {
    id: JOB_ID,
    name: JOB,
    type: "Microsoft.App/jobs",
    location: "West Europe",
    identity: { type: "UserAssigned", userAssignedIdentities: { [`/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-kvset-dev`]: { principalId: "00000000-0000-0000-0000-0000000000c5", clientId: KVSET_CLIENT_ID } } },
    properties: {
      provisioningState: "Succeeded",
      environmentId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/cae-contoso-dev-ext`,
      workloadProfileName: "Consumption",
      configuration: {
        secrets: null,
        triggerType: "Manual",
        replicaTimeout: 300,
        replicaRetryLimit: 0,
        manualTriggerConfig: { replicaCompletionCount: 1, parallelism: 1 },
        scheduleTriggerConfig: null,
        eventTriggerConfig: null,
        registries: [{ server: "crcontosodev.azurecr.io", username: "", passwordSecretRef: "", identity: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-kvset-dev` }],
      },
      template: {
        containers: [
          {
            image: IMAGE,
            name: "kvset",
            args: ["kvset"],
            env: [
              { name: "SAF_VAULT_URI", value: `https://${VAULT}.vault.azure.net/` },
              { name: "SAF_VAULT_AUDIENCE", value: "https://vault.azure.net" },
              { name: "AZURE_CLIENT_ID", value: KVSET_CLIENT_ID },
            ],
            resources: { cpu: 0.25, memory: "0.5Gi", ephemeralStorage: "1Gi" },
          },
        ],
        initContainers: null,
        volumes: null,
      },
    },
  };
}

/** The dbinit job (ADR-0028) as GET shows it: the kvset job's shape with dbinit's container. */
export function dbinitJob(): J {
  const j = kvsetJob();
  const identity = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-dbinit-dev`;
  j.id = DBINIT_JOB_ID;
  j.name = DBINIT_JOB;
  j.identity = { type: "UserAssigned", userAssignedIdentities: { [identity]: { principalId: "00000000-0000-0000-0000-0000000000c7", clientId: DBINIT_CLIENT_ID } } };
  j.properties.configuration.registries[0].identity = identity;
  j.properties.template.containers = [
    {
      image: IMAGE,
      name: "dbinit",
      args: ["dbinit"],
      env: [
        { name: "SAF_PG_AUDIENCE", value: "https://ossrdbms-aad.database.windows.net" },
        { name: "SAF_PG_HOST_SUFFIX", value: "postgres.database.azure.com" },
        { name: "SAF_SQL_HOST_SUFFIX", value: "database.windows.net" },
        { name: "SAF_DB_ADMIN", value: "id-contoso-dbinit-dev" },
        { name: "AZURE_CLIENT_ID", value: DBINIT_CLIENT_ID },
      ],
      resources: { cpu: 0.25, memory: "0.5Gi", ephemeralStorage: "1Gi" },
    },
  ];
  return j;
}

export class FakeAzure {
  server!: Server;
  base = "";
  requests: Recorded[] = [];
  job: J = kvsetJob();
  /** The job's ARM ID; the routes below answer for it only. */
  jobId = JOB_ID;
  /** The job secrets with their values (GET shows names only). */
  jobSecrets: { name: string; value: string }[] = [];
  /** What the executions wrote to the vault: {name, value} resolved through the secretRef. */
  vaultWrites: { name: string; value: string }[] = [];
  /** The secret names executions with SAF_SECRET_ACTION delete removed from the vault (ADR-0060). */
  vaultDeletes: string[] = [];
  passwords = new Map<string, J>();
  executions = new Map<string, { statuses: string[]; visibleAfter: number; template: J; ran: boolean }>();
  /** Status sequence of the next execution (the last one repeats). */
  executionStatuses: string[] = ["Running", "Succeeded"];
  /** GETs of a new execution that answer 404 before it is visible. */
  executionVisibleAfter = 0;
  /** How a PATCH completes: 200 at once, Azure-AsyncOperation, or 202 + Location. */
  patchMode: "sync" | "async" | "location" = "async";
  /** Statuses of each async operation (Azure-AsyncOperation), or 202 count before 200 (Location). */
  operationStatuses: string[] = ["InProgress", "Succeeded"];
  /** An Azure-AsyncOperation URL to return instead (once), e.g. on another host. */
  operationUrlOverride: string | undefined;
  /** Simulates a PATCH that doesn't remove secrets. */
  ignoreSecretRemoval = false;
  /** Answers a PATCH that removes the secrets (secrets: []) with this status instead. */
  removalPatchStatus: number | undefined;
  /** 404s of GET applications(appId=...) before the registration is visible. */
  appNotFoundTimes = 0;
  /** Injected errors: method and a path substring; `times` limits how often one fires. Bodies quote the value. */
  failures: { method: string; path: string; status: number; times?: number; body?: J }[] = [];
  /** Answers every GET of an operation URL (status or result) with this status, e.g. 403. */
  operationDenied: number | undefined;
  /** The job's provisioningState on the GETs after each PATCH (the last one repeats; none = Succeeded). */
  jobStatesAfterPatch: string[] = [];
  /** Called with each request once it is recorded, before it is answered (tests send signals here). */
  onRequest: ((r: Recorded) => void) | undefined;
  private pendingJobStates: string[] = [];
  private ops = new Map<string, string[]>();
  private n = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d: Buffer) => (raw += d.toString()));
      req.on("end", () => this.handle(req, res, raw));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  stop(): void {
    this.server.close();
  }

  reset(): void {
    this.requests = [];
    this.job = kvsetJob();
    this.jobId = JOB_ID;
    this.jobSecrets = [];
    this.vaultWrites = [];
    this.vaultDeletes = [];
    this.passwords.clear();
    this.executions.clear();
    this.executionStatuses = ["Running", "Succeeded"];
    this.executionVisibleAfter = 0;
    this.patchMode = "async";
    this.operationStatuses = ["InProgress", "Succeeded"];
    this.operationUrlOverride = undefined;
    this.ignoreSecretRemoval = false;
    this.removalPatchStatus = undefined;
    this.appNotFoundTimes = 0;
    this.failures = [];
    this.operationDenied = undefined;
    this.jobStatesAfterPatch = [];
    this.onRequest = undefined;
    this.pendingJobStates = [];
    this.ops.clear();
    this.n = 0;
  }

  /** Requests other than GET (writes), as "METHOD path". */
  writes(): string[] {
    return this.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  /** The job as GET shows it; `advance` steps through the provisioningStates after a PATCH. */
  private jobView(advance = false): J {
    const j = JSON.parse(JSON.stringify(this.job)) as J;
    j.properties.configuration.secrets = this.jobSecrets.length ? this.jobSecrets.map((s) => ({ name: s.name })) : null;
    if (this.pendingJobStates.length) {
      j.properties.provisioningState = advance && this.pendingJobStates.length > 1 ? this.pendingJobStates.shift() : this.pendingJobStates[0];
    }
    return j;
  }

  private operation(kind: "Statuses" | "Results"): string {
    const id = `op-${++this.n}`;
    this.ops.set(id, [...this.operationStatuses]);
    return `${this.base}/subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperation${kind}/${id}?api-version=2024-03-01`;
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const url = new URL(req.url ?? "/", this.base);
    const path = decodeURIComponent(url.pathname);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const method = req.method ?? "GET";
    const recorded: Recorded = { method, path, query: url.searchParams, auth: req.headers.authorization, body, raw };
    this.requests.push(recorded);
    this.onRequest?.(recorded);

    const f = this.failures.find((x) => x.method === method && path.includes(x.path) && (x.times === undefined || x.times > 0));
    if (f) {
      if (f.times !== undefined) f.times--;
      return this.send(res, f.status, f.body ?? { error: { code: "InjectedFailure", message: `injected failure, echoing ${VALUE} and Bearer ${ARM_TOKEN}` } });
    }

    if (path.startsWith("/v1.0/")) return this.graph(method, path, url.searchParams, body as J, req, res);

    if (req.headers.authorization !== `Bearer ${ARM_TOKEN}`) return this.send(res, 401, { error: { code: "InvalidAuthenticationToken", message: "bad token" } });
    if (url.searchParams.get("api-version") !== "2024-03-01") return this.send(res, 400, { error: { code: "InvalidApiVersion", message: "api-version" } });

    const op = /\/containerappsjobOperation(Statuses|Results)\/([^/]+)$/.exec(path);
    if (op && method === "GET") {
      if (this.operationDenied) return this.send(res, this.operationDenied, { error: { code: "AuthorizationFailed", message: "no read on the operation status" } });
      const seq = this.ops.get(op[2]!) ?? [];
      const status = seq.length > 1 ? seq.shift()! : (seq[0] ?? "Succeeded");
      if (op[1] === "Results") return status === "Succeeded" ? this.send(res, 200, this.jobView()) : this.send(res, 202, undefined, { Location: `${this.base}${url.pathname}${url.search}`, "Retry-After": "1" });
      return this.send(res, 200, { id: path, name: op[2], status, ...(status === "Failed" ? { error: { code: "JobUpdateFailed", message: `failed ${VALUE}` } } : {}) });
    }

    const jobPath = this.jobId.toLowerCase();
    const jobName = this.jobId.split("/").pop()!;
    const lower = path.toLowerCase();
    if (lower === jobPath && method === "GET") return this.send(res, 200, this.jobView(true));
    if (lower === jobPath && method === "PATCH") {
      const secrets = (body as J)?.properties?.configuration?.secrets as { name: string; value: string }[] | undefined;
      if (!Array.isArray(secrets)) return this.send(res, 400, { error: { code: "BadRequest", message: "no secrets" } });
      if (secrets.length === 0 && this.removalPatchStatus) return this.send(res, this.removalPatchStatus, { error: { code: "InjectedFailure", message: `removal refused ${VALUE}` } });
      if (!(this.ignoreSecretRemoval && secrets.length === 0)) this.jobSecrets = secrets.map((s) => ({ name: s.name, value: s.value }));
      this.pendingJobStates = [...this.jobStatesAfterPatch];
      if (this.patchMode === "sync") return this.send(res, 200, this.jobView());
      if (this.patchMode === "location") return this.send(res, 202, undefined, { Location: this.operation("Results"), "Retry-After": "1" });
      const asyncUrl = this.operationUrlOverride ?? this.operation("Statuses");
      this.operationUrlOverride = undefined;
      const view = this.jobView();
      view.properties.provisioningState = "InProgress";
      return this.send(res, 201, view, { "Azure-AsyncOperation": asyncUrl, "Retry-After": "1" });
    }
    if (lower === `${jobPath}/start` && method === "POST") {
      const t = body as J;
      const env = (t?.containers?.[0]?.env ?? []) as J[];
      const ref = env.find((e) => e.name === "SAF_SECRET_VALUE")?.secretRef as string | undefined;
      if (ref && !this.jobSecrets.some((s) => s.name === ref)) return this.send(res, 400, { error: { code: "SecretRefNotFound", message: `secret ${ref} not found` } });
      const name = `${jobName}-x${++this.n}`;
      this.executions.set(name, { statuses: [...this.executionStatuses], visibleAfter: this.executionVisibleAfter, template: t, ran: false });
      return this.send(res, 202, { name, id: `${this.jobId}/executions/${name}` }, { Location: `${this.base}${this.jobId}/executions/${name}?api-version=2024-03-01` });
    }
    const ex = new RegExp(`^${jobPath.replace(/[.]/g, "\\.")}/executions/([^/]+)$`).exec(lower);
    if (ex && method === "GET") {
      const e = this.executions.get(ex[1]!);
      if (!e) return this.send(res, 404, { error: { code: "NotFound", message: "no execution" } });
      if (e.visibleAfter > 0) {
        e.visibleAfter--;
        return this.send(res, 404, { error: { code: "NotFound", message: "not yet" } });
      }
      const status = e.statuses.length > 1 ? e.statuses.shift()! : (e.statuses[0] ?? "Succeeded");
      if (status === "Succeeded" && !e.ran) {
        e.ran = true;
        // The job "ran": resolve the secretRef now (the secret must still be on the job).
        const env = (e.template.containers?.[0]?.env ?? []) as J[];
        const ref = env.find((x) => x.name === "SAF_SECRET_VALUE")?.secretRef as string | undefined;
        const secretName = env.find((x) => x.name === "SAF_SECRET_NAME")?.value as string | undefined;
        const value = this.jobSecrets.find((s) => s.name === ref)?.value;
        const action = env.find((x) => x.name === "SAF_SECRET_ACTION")?.value as string | undefined;
        if (action === "delete" && secretName) this.vaultDeletes.push(secretName);
        else if (secretName && value !== undefined) this.vaultWrites.push({ name: secretName, value });
      }
      return this.send(res, 200, { id: `${this.jobId}/executions/${ex[1]!}`, name: ex[1], type: "Microsoft.App/jobs/executions", properties: { status, startTime: "2026-10-30T12:00:00Z", template: e.template } });
    }
    return this.send(res, 404, { error: { code: "ResourceNotFound", message: `no route ${method} ${path}` } });
  }

  /** Adds an existing password credential (as an earlier run or a person left it); listed with $select=passwordCredentials. */
  seedPassword(keyId: string, displayName: string, startDateTime: string, endDateTime: string): void {
    this.passwords.set(keyId, { customKeyIdentifier: null, displayName, endDateTime, hint: HINT, keyId, secretText: null, startDateTime });
  }

  private graph(method: string, path: string, query: URLSearchParams, body: J | undefined, req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.authorization !== `Bearer ${GRAPH_TOKEN}`) return this.send(res, 401, { error: { code: "InvalidAuthenticationToken", message: "bad token" } });
    const app = /^\/v1\.0\/applications\(appId='([^']+)'\)$/.exec(path);
    if (app && method === "GET") {
      if (this.appNotFoundTimes > 0) {
        this.appNotFoundTimes--;
        return this.send(res, 404, { error: { code: "Request_ResourceNotFound", message: "Resource does not exist" } });
      }
      // Like Graph: passwordCredentials only when selected, with the hint and without the secret text.
      const creds = (query.get("$select") ?? "").split(",").includes("passwordCredentials")
        ? { passwordCredentials: [...this.passwords.values()].map((c) => ({ ...c, hint: HINT, secretText: null })) }
        : {};
      return app[1] === CLIENT_ID
        ? this.send(res, 200, { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#applications(id)/$entity", id: APP_OID, ...creds })
        : this.send(res, 404, { error: { code: "Request_ResourceNotFound", message: "Resource does not exist" } });
    }
    if (path === `/v1.0/applications/${APP_OID}/addPassword` && method === "POST") {
      const pc = body?.passwordCredential as J | undefined;
      const cred = { customKeyIdentifier: null, displayName: pc?.displayName, endDateTime: pc?.endDateTime, hint: VALUE.slice(0, 3), keyId: KEY_ID, secretText: VALUE, startDateTime: "2026-10-30T12:00:00Z" };
      this.passwords.set(KEY_ID, cred);
      return this.send(res, 200, { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#microsoft.graph.passwordCredential", ...cred });
    }
    if (path === `/v1.0/applications/${APP_OID}/removePassword` && method === "POST") {
      this.passwords.delete(body?.keyId as string);
      return this.send(res, 204);
    }
    return this.send(res, 404, { error: { code: "Request_ResourceNotFound", message: `no route ${method} ${path}` } });
  }
}
