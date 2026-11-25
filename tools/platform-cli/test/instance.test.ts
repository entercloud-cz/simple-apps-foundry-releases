import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { setScalar } from "../src/instance/sync.js";

// `platform instance` (ADR-0066): the inputs of the templates a person runs while onboarding an
// instance, instance.yaml's values from the instance's state, and the facts instance.sh reads.
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const S = join(FIXTURES, "instance");
const EXAMPLE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const EXAMPLES = join(REPO_ROOT, "infra", "platform", "instance", "examples");
const HOST = `prod=${join(S, "bootstrap-prod.outputs.json")}`;
const NONPROD = `nonprod=${join(S, "bootstrap-nonprod.outputs.json")}`;
const FEDERATION = join(S, "connections.json");
const PORTAL = join(S, "portal-prod.outputs.json");
const PLATFORM = join(S, "platform-prod.outputs.json");
const REGISTRATION = join(S, "entra-portal-prod.outputs.json");
const IDENTITY_TEAM = "/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-contoso-identity/providers/Microsoft.Insights/actionGroups/ag-contoso-identity-team";

const read = (f: string): Doc => JSON.parse(readFileSync(f, "utf8")) as Doc;
const writeTmp = (name: string, data: unknown): string => {
  const f = join(tmp(), name);
  writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
  return f;
};
function instanceWith(change: (doc: Doc) => void): string {
  const doc = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  change(doc);
  return writeTmp("instance.yaml", stringify(doc));
}

function inputs(template: string, args: string[], instance = EXAMPLE): { code: number | null; stdout: string; stderr: string; out?: Doc } {
  const r = cli(["instance", "inputs", template, "--instance", instance, ...args]);
  let out: Doc | undefined;
  try {
    out = JSON.parse(r.stdout) as Doc;
  } catch {
    out = undefined;
  }
  return { ...r, out };
}

describe("platform instance inputs", () => {
  it("writes exactly the example inputs of infra/platform/instance/examples for instance.example.yaml and its state", () => {
    const cases: [string, string[], string][] = [
      ["bootstrap", ["--env", "prod", "--pass", "2", "--federation", FEDERATION], "contoso-prod.bootstrap.json"],
      ["bootstrap", ["--env", "nonprod", "--pass", "1", "--outputs", HOST], "contoso-nonprod.bootstrap.json"],
      ["roles", [], "contoso.roles.json"],
      ["entra-permissions", ["--outputs", HOST], "contoso.entra-permissions.json"],
      ["portal-registration", ["--outputs", HOST, "--portal-outputs", PORTAL], "contoso-prod.portal-registration.json"],
      ["entra-audit-alert", ["--outputs", HOST, "--platform-outputs", PLATFORM, "--action-group", IDENTITY_TEAM], "contoso.entra-audit-alert.json"],
    ];
    for (const [template, args, example] of cases) {
      const r = inputs(template, args);
      assert.equal(r.code, 0, `${template}: ${r.stderr}`);
      assert.deepEqual(r.out, read(join(EXAMPLES, example)), example);
    }
    // --output writes the same JSON.
    const output = join(tmp(), "roles.json");
    assert.equal(cli(["instance", "inputs", "roles", "--instance", EXAMPLE, "--output", output]).code, 0);
    assert.deepEqual(read(output), read(join(EXAMPLES, "contoso.roles.json")));
  });

  it("bootstrap: pass 1 of the host needs no state; pass 2 elsewhere takes the provisioning federation only and the host's principals", () => {
    const host1 = inputs("bootstrap", ["--env", "prod", "--pass", "1"]).out!;
    assert.deepEqual(
      { federation: host1.federation, instancePrincipals: host1.instancePrincipals, entraEnvironments: host1.entraEnvironments, instanceIdentities: host1.instanceIdentities },
      { federation: {}, instancePrincipals: {}, entraEnvironments: ["nonprod", "prod"], instanceIdentities: true },
    );
    const np2 = inputs("bootstrap", ["--env", "nonprod", "--pass", "2", "--outputs", HOST, "--outputs", NONPROD, "--federation", FEDERATION]);
    assert.equal(np2.code, 0, np2.stderr);
    assert.deepEqual(np2.out!.federation, { provisioning: read(FEDERATION).federation.nonprod.provisioning });
    assert.deepEqual(np2.out!.instancePrincipals, { portal: "00000000-0000-0000-0000-00000000e102", entraProvisioning: "00000000-0000-0000-0000-00000000d101" });
    assert.deepEqual(np2.out!.entraEnvironments, []);
  });

  it("bootstrap: region over defaultRegion, every environment's group in list order, the fixed ManagedBy tag", () => {
    const inst = instanceWith((d) => {
      d.environments[0].region = "northeurope";
      d.environments.push({ ...structuredClone(d.environments[1]), name: "qa", promoteFrom: "nonprod" });
      d.productName = "Contoso Apps Portal";
    });
    const host = inputs("bootstrap", ["--env", "prod", "--pass", "1"], inst).out!;
    assert.deepEqual(host.entraEnvironments, ["nonprod", "prod", "qa"]);
    const np = inputs("bootstrap", ["--env", "nonprod", "--pass", "1", "--outputs", HOST], inst).out!;
    assert.equal(np.location, "northeurope");
    // Not productName (ADR-0002, amended 2026-11-22).
    assert.equal(np.managedBy, "SAF");
    assert.equal(host.managedBy, "SAF");
  });

  it("bootstrap fails without the state it needs, and says what to run first", () => {
    const noFed = inputs("bootstrap", ["--env", "prod", "--pass", "2"]);
    assert.equal(noFed.code, 1);
    assert.match(noFed.stderr, /bootstrap pass 2 needs --federation <file>: the --output of platform ado bootstrap plan --phase connections/);
    const noHost = inputs("bootstrap", ["--env", "nonprod", "--pass", "1"]);
    assert.equal(noHost.code, 1);
    assert.match(noHost.stderr, /needs the bootstrap outputs of the portal host environment prod \(--outputs prod=<file>, deployment bootstrap-contoso-prod\): bootstrap prod first/);
    // sc-platform-entra not created (approvers unresolved): null in the federation.
    const fed = read(FEDERATION);
    fed.federation.prod.entra = null;
    delete fed.federation.prod.adoAutomation;
    const partial = inputs("bootstrap", ["--env", "prod", "--pass", "2", "--federation", writeTmp("fed.json", fed)]);
    assert.equal(partial.code, 1);
    assert.match(partial.stderr, /no issuer and subject of sc-platform-ado \(environment prod, adoAutomation\)/);
    assert.match(partial.stderr, /no issuer and subject of sc-platform-entra \(environment prod, entra\): the service connection doesn't exist yet/);
    assert.match(inputs("bootstrap", ["--env", "prod", "--pass", "2", "--federation", HOST.slice(5)]).stderr, /--federation has no federation/);
  });

  it("bootstrap refuses bad arguments and outputs of another subscription or tenant", () => {
    assert.equal(inputs("bootstrap", ["--env", "prod", "--pass", "3"]).code, 2);
    assert.equal(inputs("bootstrap", ["--pass", "1"]).code, 2);
    const fedOnPass1 = inputs("bootstrap", ["--env", "prod", "--pass", "1", "--federation", FEDERATION]);
    assert.equal(fedOnPass1.code, 2);
    assert.match(fedOnPass1.stderr, /--federation applies to --pass 2 only/);
    assert.match(inputs("bootstrap", ["--env", "qa", "--pass", "1"]).stderr, /instance\.yaml has no environment "qa"/);
    const swapped = inputs("bootstrap", ["--env", "nonprod", "--pass", "1", "--outputs", `prod=${join(S, "bootstrap-nonprod.outputs.json")}`]);
    assert.equal(swapped.code, 1);
    assert.match(swapped.stderr, /--outputs prod is for subscription 00000000-0000-0000-0000-00000000a001, not environment prod's/);
    const other = read(join(S, "bootstrap-prod.outputs.json"));
    other.tenantId.value = "00000000-0000-0000-0000-000000000002";
    assert.match(inputs("bootstrap", ["--env", "nonprod", "--pass", "1", "--outputs", `prod=${writeTmp("o.json", other)}`]).stderr, /--outputs prod is for tenant 00000000-0000-0000-0000-000000000002/);
    assert.match(inputs("bootstrap", ["--env", "nonprod", "--pass", "1", "--outputs", "qa=x.json"]).stderr, /--outputs qa: not an environment of this instance/);
    assert.equal(inputs("roles", ["--env", "prod"]).code, 2, "--env is bootstrap's only");
    assert.equal(inputs("nope", []).code, 2);
  });

  it("bootstrap of another environment fails while the host's outputs have no portal identity", () => {
    const old = read(join(S, "bootstrap-prod.outputs.json"));
    delete old.portalIdentity;
    const r = inputs("bootstrap", ["--env", "nonprod", "--pass", "1", "--outputs", `prod=${writeTmp("o.json", old)}`]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the bootstrap outputs of prod \(portal\.hostEnvironment\) have no portalIdentity/);
  });

  it("roles: every environment's subscription once, in list order", () => {
    const inst = instanceWith((d) => {
      d.environments.push({ ...structuredClone(d.environments[0]), name: "test", subscriptionId: "00000000-0000-0000-0000-00000000B001".toLowerCase() });
    });
    assert.deepEqual(inputs("roles", [], inst).out!.environmentSubscriptionIds, ["00000000-0000-0000-0000-00000000a001", "00000000-0000-0000-0000-00000000b001"]);
  });

  it("entra-permissions needs the host's outputs", () => {
    const r = inputs("entra-permissions", ["--outputs", NONPROD]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the Graph permissions needs the bootstrap outputs of the portal host environment prod/);
  });

  it("portal-registration: the portal's own host name, else pass 1's Container App address; localhost redirect URIs on a nonprod host only", () => {
    // ADR-0071: portal.contoso.com (the default zone, Front Door in prod) needs no portal deployment.
    const early = inputs("portal-registration", ["--outputs", HOST]);
    assert.equal(early.code, 0, early.stderr);
    assert.deepEqual(early.out, read(join(EXAMPLES, "contoso-prod.portal-registration.json")));
    assert.equal(inputs("portal-registration", ["--outputs", HOST], instanceWith((d) => (d.portal.hostName = "Portal.Contoso.com"))).code, 1, "the schema refuses upper case");
    // Without a host name of its own: the Container App's address from pass 1.
    const noHost = instanceWith((d) => (d.portal.hostName = ""));
    const r = inputs("portal-registration", ["--outputs", HOST], noHost);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the portal has no host name of its own \(portal\.hostName is "" in instance\.yaml\), so its registration needs the Container App's address: --portal-outputs <file>, the outputs of portal-contoso-prod/);
    const fromPass1 = inputs("portal-registration", ["--outputs", HOST, "--portal-outputs", PORTAL], noHost);
    assert.equal(fromPass1.out!.portalHostName, "ca-contoso-portal.happyfield-00000000.westeurope.azurecontainerapps.io");
    const empty = inputs("portal-registration", ["--outputs", HOST, "--portal-outputs", writeTmp("p.json", { managedEnvironmentDefaultDomain: { type: "String", value: "x" } })], noHost);
    assert.match(empty.stderr, /--portal-outputs has no portalFqdn/);
    const dev = inputs("portal-registration", ["--outputs", HOST, "--portal-outputs", PORTAL, "--dev-redirect-uri", "http://localhost:5173/"]);
    assert.equal(dev.code, 1);
    assert.match(dev.stderr, /allowed only on a nonprod portal host, and prod is prod/);
    // A nonprod host (a test instance): the URIs go through; the portal's kind follows the host.
    const nonprodHost = instanceWith((d) => {
      d.portal.hostEnvironment = "nonprod";
    });
    const nonprodOutputs = read(join(S, "bootstrap-prod.outputs.json"));
    nonprodOutputs.subscriptionId.value = "00000000-0000-0000-0000-00000000a001";
    const ok = inputs(
      "portal-registration",
      ["--outputs", `nonprod=${writeTmp("o.json", nonprodOutputs)}`, "--portal-outputs", PORTAL, "--dev-redirect-uri", "http://localhost:5173/"],
      nonprodHost,
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual([ok.out!.environmentName, ok.out!.environmentKind, ok.out!.devRedirectUris], ["nonprod", "nonprod", ["http://localhost:5173/"]]);
  });

  it("entra-audit-alert: another workspace with its region; the platform deployment is required; no action group twice", () => {
    const ws = "/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-identity-logs/providers/Microsoft.OperationalInsights/workspaces/log-identity";
    const r = inputs("entra-audit-alert", ["--outputs", HOST, "--platform-outputs", PLATFORM, "--workspace", ws, "--workspace-location", "northeurope"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.out!.workspaceResourceId, r.out!.location, r.out!.actionGroupIds.length], [ws, "northeurope", 1]);
    assert.equal(inputs("entra-audit-alert", ["--outputs", HOST, "--platform-outputs", PLATFORM, "--workspace", ws]).code, 2);
    const none = inputs("entra-audit-alert", ["--outputs", HOST]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /needs the host's platform deployment: --platform-outputs <file>, the outputs of platform-contoso-prod/);
    const twice = inputs("entra-audit-alert", ["--outputs", HOST, "--platform-outputs", PLATFORM, "--action-group", read(PLATFORM).platformActionGroupId.value]);
    assert.match(twice.stderr, /an action group is listed twice/);
    assert.match(inputs("entra-audit-alert", ["--outputs", HOST, "--platform-outputs", PLATFORM, "--workspace", "/subscriptions/x", "--workspace-location", "westeurope"]).stderr, /must be the resource ID of a Log Analytics workspace/);
    assert.equal(inputs("roles", ["--platform-outputs", PLATFORM]).code, 2, "--platform-outputs is the audit alert's only");
  });
});

describe("platform instance sync", () => {
  const original = readFileSync(EXAMPLE, "utf8");
  /** instance.example.yaml without identities and without portal.clientId and portal.identityPrincipalId. */
  const bare = original
    .replace(/^identities:[\s\S]*?(?=^decommission:)/m, "")
    .replace(/^ {2}clientId: .*\n/m, "")
    .replace(/^ {2}identityPrincipalId: .*\n/m, "");
  const sync = (file: string, args: string[]) => cli(["instance", "sync", "--instance", file, ...args]);

  it("says what would change without --write, and changes nothing", () => {
    const f = writeTmp("instance.yaml", bare);
    const r = sync(f, ["--outputs", HOST, "--registration", REGISTRATION]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /identities\.entraProvisioningPrincipalId\s+\(not set\) -> 00000000-0000-0000-0000-00000000d101/);
    assert.match(r.stdout, /portal\.identityPrincipalId\s+\(not set\) -> 00000000-0000-0000-0000-00000000e102/);
    assert.match(r.stdout, /portal\.clientId\s+\(not set\) -> 00000000-0000-0000-0000-00000000e101/);
    assert.match(r.stdout, /3 values would change: write them with --write \(instance\.sh sync --apply\)/);
    assert.equal(readFileSync(f, "utf8"), bare);
  });

  it("--write adds the values and keeps every other line, comments included", () => {
    const f = writeTmp("instance.yaml", bare);
    const r = sync(f, ["--outputs", HOST, "--registration", REGISTRATION, "--write"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /3 values written to .*: commit it in a pull request/);
    const after = readFileSync(f, "utf8");
    const doc = parse(after) as Doc;
    assert.equal(doc.identities.entraProvisioningPrincipalId, "00000000-0000-0000-0000-00000000d101");
    assert.equal(doc.portal.identityPrincipalId, "00000000-0000-0000-0000-00000000e102");
    assert.equal(doc.portal.clientId, "00000000-0000-0000-0000-00000000e101");
    // Only added lines: removing them gives the input back byte for byte.
    const added = after.split("\n").filter((l) => !bare.split("\n").includes(l));
    assert.deepEqual(added.sort(), [
      "  clientId: 00000000-0000-0000-0000-00000000e101",
      "  entraProvisioningPrincipalId: 00000000-0000-0000-0000-00000000d101",
      "  identityPrincipalId: 00000000-0000-0000-0000-00000000e102",
      "identities:",
    ]);
    assert.equal(after.split("\n").filter((l) => !added.includes(l)).join("\n"), bare);
    assert.equal(cli(["validate", "instance", f]).code, 0);
    // A second run finds nothing to do.
    assert.match(sync(f, ["--outputs", HOST, "--registration", REGISTRATION, "--write"]).stdout, /OK {2}instance\.yaml already has these values/);
  });

  it("replaces a changed value in place, keeping its line's comment and alignment", () => {
    const stale = original.replace("identityPrincipalId: 00000000-0000-0000-0000-00000000e102", "identityPrincipalId: 00000000-0000-0000-0000-00000000e999");
    const f = writeTmp("instance.yaml", stale);
    const r = sync(f, ["--outputs", HOST, "--write"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /portal\.identityPrincipalId\s+00000000-0000-0000-0000-00000000e999 -> 00000000-0000-0000-0000-00000000e102/);
    assert.match(r.stdout, /portal\.clientId\s+not available: no portal registration yet \(deployment entra-portal-prod, --registration\) \(keeps 00000000-0000-0000-0000-00000000e101\)/);
    assert.equal(readFileSync(f, "utf8"), original, "exactly the original again");
  });

  it("portal.cliClientId from the registration's cliClientId (ADR-0075); an older registration has none", () => {
    const noCli = original.replace(/^ {2}cliClientId: .*\n/m, "");
    const f = writeTmp("instance.yaml", noCli);
    const r = sync(f, ["--outputs", HOST, "--registration", REGISTRATION, "--write"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /portal\.cliClientId\s+\(not set\) -> 00000000-0000-0000-0000-00000000e105/);
    assert.equal((parse(readFileSync(f, "utf8")) as Doc).portal.cliClientId, "00000000-0000-0000-0000-00000000e105");
    const older = read(REGISTRATION);
    delete older.cliClientId;
    delete older.cliScope;
    const o = sync(writeTmp("instance.yaml", noCli), ["--outputs", HOST, "--registration", writeTmp("older.json", older)]);
    assert.equal(o.code, 0, o.stderr);
    assert.match(o.stdout, /portal\.cliClientId\s+not available: the portal registration has no platform CLI yet \(re-run entra-portal-prod with this core version\)/);
    const bad = sync(writeTmp("instance.yaml", noCli), ["--outputs", HOST, "--registration", writeTmp("bad.json", { ...older, cliClientId: { type: "String", value: "not-a-guid" } })]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /cliClientId that is not a GUID/);
  });

  it("the example is already in sync with its state; upper-case GUIDs count as equal", () => {
    const f = writeTmp("instance.yaml", original.replace("00000000-0000-0000-0000-00000000d101", "00000000-0000-0000-0000-00000000D101"));
    const r = sync(f, ["--outputs", HOST, "--registration", REGISTRATION]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /OK {2}instance\.yaml already has these values/);
  });

  it("portal.apiBaseUrl from the portal deployment's portalUrl, while it is not set or is still the Container App's address", () => {
    const containerApp = "https://ca-contoso-portal.happyfield-00000000.westeurope.azurecontainerapps.io";
    const esc = (v: string): string => v.replace(/\./g, "\\.");
    const noUrl = original.replace(/^ {2}apiBaseUrl: .*\n/m, "");
    const noHost = noUrl.replace("  hostEnvironment: prod", '  hostName: ""\n  hostEnvironment: prod');
    const f = writeTmp("instance.yaml", noUrl);
    const r = sync(f, ["--outputs", HOST, "--registration", REGISTRATION, "--portal-outputs", PORTAL, "--write"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /portal\.apiBaseUrl\s+\(not set\) -> https:\/\/portal\.contoso\.com/);
    assert.match(r.stdout, /1 value written to /);
    assert.equal((parse(readFileSync(f, "utf8")) as Doc).portal.apiBaseUrl, "https://portal.contoso.com");
    assert.equal(cli(["validate", "instance", f]).code, 0);
    assert.match(sync(writeTmp("instance.yaml", original), ["--outputs", HOST, "--registration", REGISTRATION, "--portal-outputs", PORTAL]).stdout,
      /OK {2}instance\.yaml already has these values/);
    // ADR-0071: the Container App's address, which sync wrote before the portal got its own host name, moves.
    const moved = writeTmp("instance.yaml", original.replace("apiBaseUrl: https://portal.contoso.com", `apiBaseUrl: ${containerApp}`));
    const m = sync(moved, ["--outputs", HOST, "--registration", REGISTRATION, "--portal-outputs", PORTAL, "--write"]);
    assert.match(m.stdout, new RegExp(`portal\\.apiBaseUrl\\s+${esc(containerApp)} -> https://portal\\.contoso\\.com`));
    assert.equal(readFileSync(moved, "utf8"), original);
    // Another value set by hand: kept, and said so.
    const g = writeTmp("instance.yaml", original.replace("apiBaseUrl: https://portal.contoso.com", "apiBaseUrl: https://saf.contoso.org"));
    const kept = sync(g, ["--outputs", HOST, "--registration", REGISTRATION, "--portal-outputs", PORTAL, "--write"]);
    assert.equal(kept.code, 0, kept.stderr);
    assert.match(kept.stdout, /portal\.apiBaseUrl\s+kept https:\/\/saf\.contoso\.org \(set by hand; the portal's own host name is https:\/\/portal\.contoso\.com\)/);
    assert.match(kept.stdout, /OK {2}instance\.yaml already has these values/);
    // Without a host name of its own, outputs of a deployment before portalUrl: https:// + portalFqdn.
    const older = read(PORTAL);
    delete older.portalUrl;
    delete older.portalHostName;
    const o = sync(writeTmp("instance.yaml", noHost), ["--outputs", HOST, "--portal-outputs", writeTmp("older.json", older)]);
    assert.match(o.stdout, new RegExp(`portal\\.apiBaseUrl\\s+\\(not set\\) -> ${esc(containerApp)}`));
    // ADR-0071: the portal's own host name needs no portal deployment (one pull request before pass 1).
    const early = sync(writeTmp("instance.yaml", noUrl), ["--outputs", HOST, "--registration", REGISTRATION]);
    assert.match(early.stdout, /portal\.apiBaseUrl\s+\(not set\) -> https:\/\/portal\.contoso\.com/);
    // Without a host name of its own and without the portal deployment: not available, the value stays.
    const none = sync(writeTmp("instance.yaml", noHost), ["--outputs", HOST, "--registration", REGISTRATION]);
    assert.match(none.stdout, /portal\.apiBaseUrl\s+not available: no portal deployment yet \(deployment portal-contoso-prod, --portal-outputs\)/);
    // Outputs of another deployment (no portalFqdn) are refused.
    const wrong = sync(writeTmp("instance.yaml", noUrl), ["--outputs", HOST, "--portal-outputs", REGISTRATION]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /--portal-outputs has no portalFqdn: it must be the outputs of portal-contoso-prod/);
  });

  it("fails without the host's outputs, with a registration without clientId, and with other state files", () => {
    const f = writeTmp("instance.yaml", bare);
    const r = sync(f, ["--outputs", NONPROD]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /sync needs the bootstrap outputs of the portal host environment prod/);
    assert.match(sync(f, ["--outputs", HOST, "--registration", PORTAL]).stderr, /--registration has no clientId \(a GUID\): it must be the outputs of entra-portal-prod/);
    assert.equal(cli(["instance", "sync", "--instance", f, "--outputs", HOST, "--federation", FEDERATION]).code, 2);
    assert.equal(readFileSync(f, "utf8"), bare);
  });

  it("setScalar keeps quotes, adds a key first in its section and a missing section at the end, CRLF included", () => {
    assert.equal(setScalar('a:\n  b: "x" # c\n', ["a", "b"], "y"), 'a:\n  b: "y" # c\n');
    assert.equal(setScalar("a:\n  # about c\n  c: 1\n", ["a", "b"], "y"), "a:\n  b: y\n  # about c\n  c: 1\n");
    assert.equal(setScalar("a: 1\n", ["z", "b"], "y"), "a: 1\nz:\n  b: y\n");
    assert.equal(setScalar("a: 1", ["z", "b"], "y"), "a: 1\nz:\n  b: y\n");
    assert.equal(setScalar("a:\r\n    c: 1\r\n", ["a", "b"], "y"), "a:\r\n    b: y\r\n    c: 1\r\n");
    // A flow section: the document API (still correct).
    assert.deepEqual(parse(setScalar("a: {c: 1}\n", ["a", "b"], "y")), { a: { c: 1, b: "y" } });
  });
});

describe("platform instance facts", () => {
  it("databases: Azure SQL for the portal in the host even with data.azureSql off (ADR-0070); nothing for an engine that is off", () => {
    const doc = parse(readFileSync(EXAMPLE, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    doc.data = { ...(doc.data ?? {}), postgres: { ...(doc.data?.postgres ?? {}), enabled: false }, azureSql: { ...(doc.data?.azureSql ?? {}), enabled: false } };
    const file = join(tmp("pc-facts-db-"), "instance.yaml");
    writeFileSync(file, stringify(doc));
    const r = cli(["instance", "facts", "--instance", file]);
    assert.equal(r.code, 0, r.stderr);
    const dbs = r.stdout.split("\n").filter((l) => l.startsWith("databases."));
    assert.deepEqual(dbs, ["databases.00000000-0000-0000-0000-00000000b001.westeurope=azureSql"]);
  });

  it("prints the names and coordinates instance.sh needs, one key=value per line", () => {
    const r = cli(["instance", "facts", "--instance", EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    const facts = Object.fromEntries(r.stdout.trimEnd().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.deepEqual(
      {
        prefix: facts.prefix,
        tenantId: facts.tenantId,
        hostEnvironment: facts.hostEnvironment,
        environments: facts.environments,
        subscriptions: facts.subscriptions,
        organizationUrl: facts.organizationUrl,
        platformProject: facts.platformProject,
        coreRepositoryUrl: facts.coreRepositoryUrl,
        coreVersion: facts.coreVersion,
        coreReleasesRepository: facts.coreReleasesRepository,
        entraChanges: facts.entraChanges,
        dnsZones: facts.dnsZones,
        identitiesLock: facts.identitiesLock,
        entraResourceGroup: facts.entraResourceGroup,
        rolesDeployment: facts.rolesDeployment,
        portalDeployment: facts.portalDeployment,
        registrationDeployment: facts.registrationDeployment,
        platformDeployment: facts.platformDeployment,
        prodBootstrap: facts["env.prod.bootstrapDeployment"],
        nonprodGroup: facts["env.nonprod.identitiesResourceGroup"],
        nonprodSubscription: facts["env.nonprod.subscriptionId"],
        prodLocation: facts["env.prod.location"],
      },
      {
        prefix: "contoso",
        tenantId: "00000000-0000-0000-0000-000000000001",
        hostEnvironment: "prod",
        environments: "nonprod prod",
        subscriptions: "00000000-0000-0000-0000-00000000a001 00000000-0000-0000-0000-00000000b001",
        organizationUrl: "https://dev.azure.com/contoso",
        platformProject: "Platform",
        coreRepositoryUrl: "https://dev.azure.com/contoso/Platform/_git/core",
        coreVersion: "v0.1.0",
        coreReleasesRepository: "https://github.com/contoso/simple-apps-foundry-releases",
        entraChanges: "pullRequest",
        dnsZones: "contoso.com contoso.eu",
        identitiesLock: "lock-contoso-identities-readonly",
        entraResourceGroup: "rg-contoso-entra",
        rolesDeployment: "roles-contoso",
        portalDeployment: "portal-contoso-prod",
        registrationDeployment: "entra-portal-prod",
        platformDeployment: "platform-contoso-prod",
        prodBootstrap: "bootstrap-contoso-prod",
        nonprodGroup: "rg-contoso-identities-nonprod",
        nonprodSubscription: "00000000-0000-0000-0000-00000000a001",
        prodLocation: "westeurope",
      },
    );
    // The CAEs per subscription and region: two modes each, plus the portal's in the host.
    assert.equal(facts["managedEnvironments.00000000-0000-0000-0000-00000000a001.westeurope"], "2");
    assert.equal(facts["managedEnvironments.00000000-0000-0000-0000-00000000b001.westeurope"], "3");
    // The database engines per subscription and region: both data engines everywhere (the schema's defaults), and
    // PostgreSQL for the portal in the host.
    assert.equal(facts["databases.00000000-0000-0000-0000-00000000a001.westeurope"], "postgres azureSql");
    assert.equal(facts["databases.00000000-0000-0000-0000-00000000b001.westeurope"], "postgres azureSql");
    // The Azure DNS zones for instance.sh dns: the manual zone contoso.eu has none.
    assert.deepEqual(
      Object.fromEntries(Object.entries(facts).filter(([k]) => k === "azureDnsZones" || k.startsWith("dnsZone."))),
      {
        azureDnsZones: "contoso.com",
        "dnsZone.contoso.com.id": "/subscriptions/00000000-0000-0000-0000-00000000d001/resourceGroups/rg-dns/providers/Microsoft.Network/dnszones/contoso.com",
        "dnsZone.contoso.com.subscriptionId": "00000000-0000-0000-0000-00000000d001",
        "dnsZone.contoso.com.resourceGroup": "rg-dns",
        "dnsZone.contoso.com.allowedEnvironments": "prod nonprod",
      },
    );
  });

  it("dnsZone.<zone>: no subscription or group when azureDnsZoneId is not that zone's ID; no Azure DNS zone, an empty list", () => {
    const doc = parse(readFileSync(EXAMPLE, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    doc.dns.zones[0].azureDnsZoneId = "/subscriptions/00000000-0000-0000-0000-00000000D001/resourceGroups/RG-DNS/providers/Microsoft.Network/dnsZones/other.com";
    doc.dns.zones.push({
      name: "apps.contoso.com",
      provider: "azureDns",
      azureDnsZoneId: "/subscriptions/00000000-0000-0000-0000-00000000D001/resourceGroups/RG-DNS/providers/Microsoft.Network/dnsZones/apps.contoso.com",
      allowedEnvironments: ["nonprod"],
    });
    const file = join(tmp("pc-facts-"), "instance.yaml");
    writeFileSync(file, stringify(doc));
    const r = cli(["instance", "facts", "--instance", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^azureDnsZones=contoso\.com apps\.contoso\.com$/m);
    assert.match(r.stdout, /^dnsZone\.contoso\.com\.subscriptionId=$/m);
    assert.match(r.stdout, /^dnsZone\.contoso\.com\.resourceGroup=$/m);
    // The subscription lowercased, the group as written (Azure compares it without case).
    assert.match(r.stdout, /^dnsZone\.apps\.contoso\.com\.subscriptionId=00000000-0000-0000-0000-00000000d001$/m);
    assert.match(r.stdout, /^dnsZone\.apps\.contoso\.com\.resourceGroup=RG-DNS$/m);
    assert.match(r.stdout, /^dnsZone\.apps\.contoso\.com\.allowedEnvironments=nonprod$/m);
    delete doc.dns;
    writeFileSync(file, stringify(doc));
    const none = cli(["instance", "facts", "--instance", file]);
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, /^azureDnsZones=$/m);
    assert.doesNotMatch(none.stdout, /^dnsZone\./m);
  });

  it("coreReleases.repository empty when unset; the core repository's URL encodes the project (ADR-0067)", () => {
    const doc = parse(readFileSync(EXAMPLE, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    delete doc.coreReleases;
    doc.scm.azureDevOps.platformProject = "Shared Platform";
    const file = join(tmp("pc-facts-"), "instance.yaml");
    writeFileSync(file, stringify(doc));
    const r = cli(["instance", "facts", "--instance", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^coreReleasesRepository=$/m);
    assert.match(r.stdout, /^coreRepositoryUrl=https:\/\/dev\.azure\.com\/contoso\/Shared%20Platform\/_git\/core$/m);
    assert.match(r.stdout, /^platformProject=Shared Platform$/m);
  });

  it("help: platform instance help, and the main help names it", () => {
    const r = cli(["instance", "help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /inputs <template> --instance <instance\.yaml>/);
    assert.match(cli(["help"]).stdout, /platform instance inputs\|sync\|facts/);
    assert.equal(cli(["instance", "nope"]).code, 2);
  });
});
