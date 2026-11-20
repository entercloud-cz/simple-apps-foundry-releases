import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";

// `platform environment` (ADR-0043): the platform pipeline's helpers.
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const E = join(FIXTURES, "environment");
const IMAGES = join(E, "images.json");
/** Stand-in AzureFrontDoor.Backend ranges, as `platform provisioning fd-ranges` writes them (RFC 5737). */
const FD_RANGES = join(E, "fd-ranges.json");
const EXAMPLE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const PIPELINE_EXAMPLES = join(REPO_ROOT, "infra", "platform", "pipeline", "examples");

const read = (f: string): Doc => JSON.parse(readFileSync(f, "utf8")) as Doc;
const writeTmp = (name: string, data: unknown): string => {
  const f = join(tmp(), name);
  writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
  return f;
};

function inputs(env: string, pass = "2", instance = EXAMPLE): { code: number | null; stdout: string; stderr: string; out?: Doc } {
  const output = join(tmp(), "env.json");
  const r = cli(["environment", "inputs", "--instance", instance, "--env", env, "--images", IMAGES, "--pass", pass, "--output", output]);
  let out: Doc | undefined;
  try {
    out = read(output);
  } catch {
    out = undefined;
  }
  return { ...r, out };
}

function instanceWith(change: (doc: Doc) => void): string {
  const doc = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  change(doc);
  return writeTmp("instance.yaml", stringify(doc));
}

describe("platform environment inputs", () => {
  it("writes exactly the example inputs of infra/platform/pipeline/examples for both example environments", () => {
    for (const env of ["nonprod", "prod"]) {
      const r = inputs(env);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.out, read(join(PIPELINE_EXAMPLES, `contoso-${env}.environment.json`)), env);
    }
  });

  it("pass 1 has no jobs digest; pass 2 the saf-jobs digest of images.json", () => {
    assert.equal(inputs("nonprod", "1").out!.platformJobsImageDigest, "");
    assert.equal(inputs("nonprod", "2").out!.platformJobsImageDigest, read(IMAGES).images["saf-jobs"].digest);
    assert.match(inputs("nonprod", "3").stderr, /--pass must be 1/);
  });

  it("resolves defaults: vnet variant (NAT Gateway IPs), created hybrid spoke, Front Door external or unlisted, no team address, no portal", () => {
    const inst = instanceWith((d) => {
      d.environments[0].networkModes.externalOnly = { network: "vnet", vnetAddressSpace: "10.20.0.0/23", caeSubnetPrefix: "10.20.0.0/25", privateEndpointSubnetPrefix: "10.20.1.0/24" };
      d.environments[0].networkModes.externalHybrid = {
        vnet: { create: { addressSpace: "10.21.0.0/23" } },
        caeSubnetPrefix: "10.21.0.0/25",
        privateEndpointSubnetPrefix: "10.21.1.0/24",
        routeTableId: d.environments[0].networkModes.externalHybrid.routeTableId,
      };
      d.frontDoor.managed.profiles = d.frontDoor.managed.profiles.filter((p: Doc) => p.environment === "prod");
      delete d.notifications.email.platformTeamAddress;
      delete d.portal.identityPrincipalId;
    });
    const out = inputs("nonprod", "2", inst).out!;
    assert.deepEqual(out.networkModes, {
      externalOnly: { network: "vnet", vnetAddressSpace: "10.20.0.0/23", caeSubnetPrefix: "10.20.0.0/25", privateEndpointSubnetPrefix: "10.20.1.0/24", natGatewayPublicIpCount: 1 },
      externalHybrid: {
        vnet: { create: { addressSpace: "10.21.0.0/23", useRemoteGateways: false } },
        caeSubnetPrefix: "10.21.0.0/25",
        privateEndpointSubnetPrefix: "10.21.1.0/24",
        routeTableId: out.networkModes.externalHybrid.routeTableId,
        dnsServers: [],
      },
    });
    assert.equal(out.frontDoor, null, "no profile for nonprod");
    assert.deepEqual(out.platformAlertEmails, []);
    assert.equal(out.portalIdentityPrincipalId, "");
    const external = instanceWith((d) => {
      d.frontDoor = { mode: "external", external: { profiles: [{ name: "afd-corp", allowedEnvironments: ["prod"] }] } };
    });
    assert.equal(inputs("prod", "2", external).out!.frontDoor, null, "external mode: the platform deploys no profile");
  });

  it("fails without identities.entraProvisioningPrincipalId, for internalOnly and an unknown environment", () => {
    const noEntra = instanceWith((d) => delete d.identities);
    const r = inputs("prod", "2", noEntra);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /identities\.entraProvisioningPrincipalId is required by the platform pipeline/);
    const internal = instanceWith((d) => {
      d.environments[1].networkModes.internalOnly = structuredClone(d.environments[1].networkModes.externalHybrid);
    });
    assert.match(inputs("prod", "2", internal).stderr, /internalOnly is not built in this core version/);
    assert.match(inputs("qa").stderr, /instance\.yaml has no environment "qa"/);
  });
});

describe("platform environment portal-inputs", () => {
  function portal(env: string, pass = "auto", instance = EXAMPLE, ranges: string | null = FD_RANGES): { code: number | null; stdout: string; stderr: string; out?: Doc } {
    const output = join(tmp(), "portal.json");
    const r = cli([
      "environment", "portal-inputs", "--instance", instance, "--env", env, "--images", IMAGES, "--pass", pass,
      ...(ranges === null ? [] : ["--fd-ranges", ranges]), "--output", output,
    ]);
    let out: Doc | undefined;
    try {
      out = read(output);
    } catch {
      out = undefined;
    }
    return { ...r, out };
  }

  it("writes exactly infra/platform/pipeline/examples/contoso-prod.portal.json for the host (auto = pass 2 with portal.clientId)", () => {
    const r = portal("prod");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK {2}portal inputs for prod \(pass 2\) written to /m);
    assert.deepEqual(r.out, read(join(PIPELINE_EXAMPLES, "contoso-prod.portal.json")));
    assert.deepEqual(portal("prod", "2").out, r.out);
    assert.equal(r.out!.portalImageDigest, read(IMAGES).images["saf-portal"].digest);
  });

  it("pass 1 has no digest and no client ID; auto without portal.clientId is pass 1; pass 2 needs it", () => {
    const one = portal("prod", "1").out!;
    assert.equal(one.portalImageDigest, "");
    assert.equal(one.portalClientId, "");
    assert.deepEqual({ ...one, portalImageDigest: "x", portalClientId: "x" }, { ...portal("prod").out!, portalImageDigest: "x", portalClientId: "x" });
    const noClient = instanceWith((d) => delete d.portal.clientId);
    const auto = portal("prod", "auto", noClient);
    assert.equal(auto.code, 0, auto.stderr);
    assert.match(auto.stdout, /\(pass 1\)/);
    assert.equal(auto.out!.portalImageDigest, "");
    const two = portal("prod", "2", noClient);
    assert.equal(two.code, 1);
    assert.match(two.stderr, /portal\.clientId is required for pass 2/);
    assert.match(portal("prod", "3").stderr, /--pass must be 1 \(no Container App\), 2/);
  });

  // ADR-0071: the portal's own host name through the host's managed Front Door profile.
  it("the portal's own host name: portal.{default zone} by default, records by hand for a zone in another subscription", () => {
    const r = portal("prod");
    assert.deepEqual(r.out!.frontDoor, { hostName: "portal.contoso.com", dnsZoneId: "", backendIpRanges: ["192.0.2.0/24", "198.51.100.0/24"] });
    // The zone in the host's own subscription: the template writes the records there.
    const sameSub = instanceWith((d) => {
      d.dns.zones[0].azureDnsZoneId = d.dns.zones[0].azureDnsZoneId.replace(/\/subscriptions\/[^/]+\//, `/subscriptions/${d.environments[1].subscriptionId}/`);
    });
    const zoned = portal("prod", "auto", sameSub).out!.frontDoor;
    assert.match(zoned.dnsZoneId, /\/dnszones\/contoso\.com$/);
    // Pass 1 may come before the ranges; pass 2 with a host name needs them.
    assert.deepEqual(portal("prod", "1", EXAMPLE, null).out!.frontDoor, { hostName: "portal.contoso.com", dnsZoneId: "", backendIpRanges: [] });
    const noRanges = portal("prod", "2", EXAMPLE, null);
    assert.equal(noRanges.code, 1);
    assert.match(noRanges.stderr, /pass 2 with the portal's own host name portal\.contoso\.com needs --fd-ranges/);
    const bad = portal("prod", "auto", EXAMPLE, writeTmp("bad-ranges.json", { ranges: ["0.0.0.0/0"] }));
    assert.match(bad.stderr, /--fd-ranges ranges\[0\] "0\.0\.0\.0\/0" is wider than a \/8/);
  });

  it("no own host name: portal.hostName \"\", no profile in the host, or no zone for it; an explicit host must be reserved in its zone", () => {
    const none = { hostName: "", dnsZoneId: "", backendIpRanges: [] };
    const off = portal("prod", "auto", instanceWith((d) => (d.portal.hostName = "")));
    assert.equal(off.code, 0, off.stderr);
    assert.deepEqual(off.out!.frontDoor, none);
    const external = instanceWith((d) => {
      d.frontDoor = { mode: "external", external: { profiles: [{ name: "afd-network-team", allowedEnvironments: ["prod"] }] } };
    });
    assert.deepEqual(portal("prod", "auto", external).out!.frontDoor, none);
    const noProfile = instanceWith((d) => (d.frontDoor.managed.profiles = d.frontDoor.managed.profiles.filter((p: Doc) => p.environment !== "prod")));
    assert.deepEqual(portal("prod", "auto", noProfile).out!.frontDoor, none);
    // A host set by hand with no profile fails: the portal's host name goes only through Front Door.
    const handNoProfile = instanceWith((d) => {
      d.portal.hostName = "portal.contoso.com";
      d.frontDoor.managed.profiles = d.frontDoor.managed.profiles.filter((p: Doc) => p.environment !== "prod");
    });
    assert.match(portal("prod", "auto", handNoProfile).stderr, /needs a managed Front Door profile in the portal host environment prod/);
    // A host in a zone of dns.zones whose subdomain isn't reserved: an app could be given it.
    const notReserved = portal("prod", "auto", instanceWith((d) => (d.portal.hostName = "selfservice.contoso.com")));
    assert.equal(notReserved.code, 1);
    assert.match(notReserved.stderr, /its subdomain "selfservice" must be in dns\.reservedSubdomains/);
    // Outside every zone of dns.zones (another team's DNS): allowed, records by hand.
    const elsewhere = portal("prod", "auto", instanceWith((d) => (d.portal.hostName = "saf.contoso.org")));
    assert.equal(elsewhere.code, 0, elsewhere.stderr);
    assert.deepEqual(elsewhere.out!.frontDoor, { hostName: "saf.contoso.org", dnsZoneId: "", backendIpRanges: ["192.0.2.0/24", "198.51.100.0/24"] });
  });

  it("only the host environment; a hub route table or a missing size S fail", () => {
    const other = portal("nonprod");
    assert.equal(other.code, 1);
    assert.match(other.stderr, /environment nonprod is not portal\.hostEnvironment \(prod\)/);
    const hub = instanceWith((d) => {
      d.portal.network.routeTableId = d.environments[1].networkModes.externalHybrid.routeTableId;
    });
    assert.match(portal("prod", "auto", hub).stderr, /portal\.network\.routeTableId is not available in this core version/);
    const noS = instanceWith((d) => {
      d.data.azureSql.sizes = { M: d.data.azureSql.sizes.M };
    });
    // The schema already requires S (the portal database's size); the CLI fails on it either way.
    assert.match(portal("prod", "auto", noS).stderr, /data\.azureSql\.sizes(: missing required property "S"| has no size S)/);
  });

  it("resolves defaults: a nonprod host's backup, the default sizes and branch; GUIDs lowercased; only the ADO fields the portal reads", () => {
    const inst = instanceWith((d) => {
      d.portal.hostEnvironment = "nonprod";
      d.portal.clientId = d.portal.clientId.toUpperCase().replace("E101", "E1AB");
      delete d.portal.network.approvalReference;
      delete d.data;
      delete d.scm.azureDevOps.platformConfigDefaultBranch;
    });
    const r = portal("nonprod", "auto", inst);
    assert.equal(r.code, 0, r.stderr);
    const out = r.out!;
    // The portal database is Azure SQL (ADR-0070): the default size S and a nonprod host's backup.
    assert.equal(out.environmentKind, undefined);
    assert.deepEqual(out.database, {
      size: { skuName: "S0", storageGb: 250 },
      backupRetentionDays: 7,
      backupStorageRedundancy: "Local",
    });
    assert.deepEqual(out.azureDevOps, { organizationUrl: "https://dev.azure.com/contoso", platformProject: "Platform", platformConfigRepo: "platform-config", platformConfigDefaultBranch: "main" });
    assert.deepEqual(Object.keys(out.network).sort(), ["caeSubnetPrefix", "privateEndpointSubnetPrefix", "vnetAddressSpace"]);
    assert.equal(out.portalClientId, "00000000-0000-0000-0000-00000000e1ab");
    assert.deepEqual(out.tags, {});
  });

  // ADR-0025 amendment 2026-11-14, US10.18: the vault of the portal's own secrets and the SMTP secret.
  function portalSmtp(smtpSecret: string | undefined, instance: string): { code: number | null; stdout: string; stderr: string; out?: Doc } {
    const output = join(tmp(), "portal-smtp.json");
    const args = ["environment", "portal-inputs", "--instance", instance, "--env", "prod", "--images", IMAGES, "--pass", "auto", "--fd-ranges", FD_RANGES, "--output", output];
    if (smtpSecret !== undefined) args.push("--smtp-secret", smtpSecret);
    const r = cli(args);
    let out: Doc | undefined;
    try {
      out = read(output);
    } catch {
      out = undefined;
    }
    return { ...r, out };
  }
  const smtpBasic = (d: Doc): void => {
    d.notifications.email = {
      provider: "smtp",
      sender: d.notifications.email.sender,
      smtp: { host: "smtp.contoso.com", port: 587, tls: "startTls", auth: { mode: "basic", username: "portal-sender", passwordSecretName: "smtp-password" } },
    };
  };

  it("the environment vault: private with a VNet-based CAE in the host, else public; the host's vaultGeneration", () => {
    const r = portal("prod");
    assert.equal(r.out!.environmentVault, "private");
    assert.equal(r.out!.vaultGeneration, 0);
    const managedOnly = instanceWith((d) => {
      delete d.environments[1].networkModes.externalHybrid;
      d.environments[1].vaultGeneration = 2;
    });
    const m = portal("prod", "auto", managedOnly);
    assert.equal(m.code, 0, m.stderr);
    assert.equal(m.out!.environmentVault, "public");
    assert.equal(m.out!.vaultGeneration, 2);
    const isolated = instanceWith((d) => {
      delete d.environments[1].networkModes.externalHybrid;
      d.environments[1].networkModes.externalOnly = { network: "vnet", vnetAddressSpace: "10.30.0.0/23", caeSubnetPrefix: "10.30.0.0/25", privateEndpointSubnetPrefix: "10.30.1.0/24" };
    });
    const v = portal("prod", "auto", isolated);
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.out!.environmentVault, "private");
  });

  it("SMTP basic auth: the secret's name always, its existence only with --smtp-secret present; present without SMTP basic fails", () => {
    // The example sends through the shared mailbox: no SMTP password.
    assert.equal(portal("prod").out!.smtpPasswordSecretName, "");
    assert.equal(portal("prod").out!.smtpPasswordSecretExists, false);
    const absentByDefault = portalSmtp("absent", EXAMPLE);
    assert.equal(absentByDefault.code, 0, absentByDefault.stderr);
    assert.equal(absentByDefault.out!.smtpPasswordSecretExists, false);
    const notBasic = portalSmtp("present", EXAMPLE);
    assert.equal(notBasic.code, 1);
    assert.match(notBasic.stderr, /--smtp-secret present needs SMTP with a password in instance\.yaml/);
    const basic = instanceWith(smtpBasic);
    const none = portalSmtp(undefined, basic);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.out!.smtpPasswordSecretName, "smtp-password");
    assert.equal(none.out!.smtpPasswordSecretExists, false);
    const present = portalSmtp("present", basic);
    assert.equal(present.code, 0, present.stderr);
    assert.deepEqual({ ...present.out!, smtpPasswordSecretExists: false }, none.out);
    assert.equal(present.out!.smtpPasswordSecretExists, true);
    const noAuth = instanceWith((d) => {
      smtpBasic(d);
      d.notifications.email.smtp.auth = { mode: "none" };
    });
    assert.equal(portalSmtp(undefined, noAuth).out!.smtpPasswordSecretName, "");
    assert.match(portalSmtp("maybe", basic).stderr, /--smtp-secret must be present or absent/);
  });
});

describe("platform environment validate-run", () => {
  const run = (environment: string, host = "prod", coreRef = "refs/tags/v0.1.0") => cli(["environment", "validate-run", "--instance", EXAMPLE, "--environment", environment, "--host-environment", host, "--core-ref", coreRef]);

  it("accepts what generate renders and the pinned core tag", () => {
    const r = run("nonprod");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK {2}platform environment nonprod, host prod, core refs\/tags\/v0\.1\.0$/m);
    assert.match(run("prod").stdout, /platform environment prod \(portal host\)/);
  });

  it("refuses an environment not in instance.yaml, another host and another core ref", () => {
    assert.match(run("qa").stderr, /parameters\.environment "qa" is not an environment of instance\.yaml/);
    assert.match(run("Bad-1").stderr, /parameters\.environment is not an environment name/);
    assert.match(run("nonprod", "nonprod").stderr, /parameters\.hostEnvironment is "nonprod", but instance\.yaml portal\.hostEnvironment is "prod"/);
    assert.match(run("nonprod", "prod", "refs/tags/v9.9.9").stderr, /pins coreVersion v0\.1\.0/);
  });
});

describe("platform environment roles-check", () => {
  const SUB = "00000000-0000-0000-0000-00000000a001";
  const roles = read(join(E, "roles.compiled.json"));
  const names = {
    outputs: {
      customRoles: {
        value: [
          { key: "appDeployer", id: "2a69bb83-773b-5e58-99ed-8cb2807a179b", roleName: "App Deployer (contoso)" },
          { key: "appEnvironmentJoiner", id: "5f449438-710b-5a82-a8ee-9e6c9453155a", roleName: "App Environment Joiner (contoso)" },
          { key: "platformJobSecretWriter", id: "5532a41a-71e9-5285-b333-6e73b00694d3", roleName: "Platform Job Secret Writer (contoso)" },
        ],
      },
    },
  };
  const ACTIONS: Record<string, string> = { appDeployer: "appDeployerActions", appEnvironmentJoiner: "appEnvironmentJoinerActions", platformJobSecretWriter: "platformJobSecretWriterActions" };
  // `az role definition list` as the roles look once roles.bicep is deployed.
  const definitions = (): Doc[] =>
    names.outputs.customRoles.value.map((r) => ({
      name: r.id,
      roleName: r.roleName,
      roleType: "CustomRole",
      assignableScopes: [`/subscriptions/${SUB}`, "/subscriptions/00000000-0000-0000-0000-00000000b001"],
      permissions: [{ actions: [...roles.variables[ACTIONS[r.key]!]].reverse(), notActions: [], dataActions: [], notDataActions: [] }],
    }));
  // bicep snapshot writes outputs as plain values; the check reads them through `value`-less entries too.
  const namesFile = (): string => writeTmp("names.json", { outputs: { customRoles: names.outputs.customRoles.value } });
  const check = (defs: Doc[], sub = SUB) =>
    cli(["environment", "roles-check", "--names", namesFile(), "--roles", join(E, "roles.compiled.json"), "--definitions", writeTmp("defs.json", defs), "--subscription", sub]);

  it("accepts the three roles as roles.bicep defines them (actions in any order), assignable here", () => {
    const r = check(definitions());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK {2}custom roles defined as this core's roles\.bicep and assignable here: App Deployer \(contoso\), App Environment Joiner \(contoso\), Platform Job Secret Writer \(contoso\)$/m);
  });

  it("fails closed: a missing role, other actions, data actions, another scope; the fix is a person running roles.bicep", () => {
    const missing = check(definitions().slice(0, 2));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Platform Job Secret Writer \(contoso\) \(5532a41a-71e9-5285-b333-6e73b00694d3\) is not defined or not assignable in subscription/);
    assert.match(missing.stderr, /deploys infra\/platform\/roles\.bicep of this core version/);
    const older = definitions();
    older[0]!.permissions[0].actions = older[0]!.permissions[0].actions.slice(1).concat(["Microsoft.App/containerApps/delete"]);
    const r = check(older);
    assert.match(r.stderr, /App Deployer \(contoso\): its actions differ from this core's roles\.bicep \(missing [^;]+; extra Microsoft\.App\/containerApps\/delete\)/);
    const data = definitions();
    data[1]!.permissions[0].dataActions = ["Microsoft.KeyVault/vaults/secrets/getSecret/action"];
    assert.match(check(data).stderr, /App Environment Joiner \(contoso\): dataActions must be empty/);
    assert.match(check(definitions(), "00000000-0000-0000-0000-00000000c001").stderr, /is not defined or not assignable in subscription|is not among its assignable scopes/);
    const scoped = definitions();
    scoped[2]!.assignableScopes = ["/subscriptions/00000000-0000-0000-0000-00000000b001"];
    assert.match(check(scoped).stderr, /Platform Job Secret Writer \(contoso\): subscription 00000000-0000-0000-0000-00000000a001 is not among its assignable scopes/);
  });
});

describe("platform environment compare", () => {
  it("as provisioning compare --kind environment", () => {
    const rec = { name: "platform-contoso-nonprod", properties: { provisioningState: "Succeeded", templateHash: "42", parameters: { prefix: { value: "contoso" }, platformJobsImageDigest: { value: "sha256:a" } } } };
    const r = writeTmp("r.json", rec);
    const v = (digest: string): string => writeTmp("v.json", { properties: { templateHash: "42", parameters: { prefix: { value: "contoso" }, platformJobsImageDigest: { value: digest } } } });
    assert.equal(cli(["environment", "compare", "--validate", v("sha256:a"), "--record", r]).stdout, "up-to-date\n");
    assert.equal(cli(["environment", "compare", "--validate", v("sha256:b"), "--record", r]).stdout, "changed: parameters platformJobsImageDigest\n");
    assert.equal(cli(["environment", "compare", "--validate", v("sha256:b")]).stdout, "new\n");
    assert.equal(cli(["provisioning", "compare", "--kind", "environment", "--validate", v("sha256:b"), "--record", r]).stdout, "changed: parameters platformJobsImageDigest\n");
    assert.equal(cli(["environment", "nope"]).code, 2);
  });
});

describe("platform environment cae-network", () => {
  // ADR-0043 amendment 2026-11-15 (US03.03): an existing CAE keeps its network; the plan stops before what-if.
  const SUB = "00000000-0000-0000-0000-00000000a001";
  const RG = "rg-contoso-platform-nonprod";
  const EXT = "cae-contoso-ext-nonprod";
  const HYB = "cae-contoso-hyb-nonprod";
  const extSubnet = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/vnet-contoso-ext-nonprod/subnets/snet-contoso-cae-ext-nonprod`;
  const hybSubnet = `/subscriptions/${SUB}/resourceGroups/rg-network-nonprod/providers/Microsoft.Network/virtualNetworks/vnet-spoke-apps-nonprod/subnets/snet-contoso-cae-hyb-nonprod`;
  const names = { outputs: { managedEnvironments: [{ mode: "externalOnly", name: EXT }, { mode: "externalHybrid", name: HYB }] } };
  const cae = (name: string, subnet: string | null | undefined): Doc => ({
    id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/managedEnvironments/${name}`,
    name,
    type: "Microsoft.App/managedEnvironments",
    properties: subnet === undefined ? {} : { vnetConfiguration: subnet === null ? null : { infrastructureSubnetId: subnet, internal: false } },
  });
  // bicep snapshot of environment.bicepparam: the predicted CAEs (managed: vnetConfiguration null), among other resources.
  const snapshot = (caes: Record<string, string | null>): Doc => ({
    predictedResources: [
      { type: "Microsoft.OperationalInsights/workspaces", name: "log-contoso-nonprod", properties: {} },
      ...Object.entries(caes).map(([name, subnet]) => cae(name, subnet)),
    ],
  });
  const run = (snap: Doc, live: Doc[], namesDoc: Doc = names) => {
    const output = join(tmp(), "cae-network.json");
    const r = cli(["environment", "cae-network", "--names", writeTmp("names.json", namesDoc), "--snapshot", writeTmp("snap.json", snap),
      "--live", writeTmp("live.json", live), "--output", output]);
    let out: Doc | undefined;
    try {
      out = read(output);
    } catch {
      out = undefined;
    }
    return { ...r, out };
  };
  const live = (ext: Doc | null, hyb: Doc | null): Doc[] => [{ mode: "externalOnly", name: EXT, resource: ext }, { mode: "externalHybrid", name: HYB, resource: hyb }];

  it("passes an unchanged CAE and never refuses a new one", () => {
    const r = run(snapshot({ [EXT]: null, [HYB]: hybSubnet }), live(cae(EXT, null), null));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out!.caes, [
      { mode: "externalOnly", name: EXT, state: "unchanged", current: "", wanted: "" },
      { mode: "externalHybrid", name: HYB, state: "new", wanted: hybSubnet },
    ]);
    assert.deepEqual(r.out!.refused, []);
    assert.match(r.stdout, /cae-contoso-ext-nonprod \(External only\): exists, network unchanged \(the Azure-managed network \(no VNet\)\)/);
    assert.match(r.stdout, /cae-contoso-hyb-nonprod \(External with internal access\): new, on the subnet \/subscriptions\//);
    assert.match(r.stdout, /^OK {2}no existing CAE changes its network$/m);
  });

  it("reads a managed CAE whatever Azure returns for it: no vnetConfiguration, null, or an empty or null subnet", () => {
    const nullSubnet: Doc = { ...cae(EXT, null), properties: { vnetConfiguration: { infrastructureSubnetId: null, internal: false } } };
    for (const ext of [cae(EXT, undefined), cae(EXT, null), cae(EXT, ""), nullSubnet]) {
      const r = run(snapshot({ [EXT]: null }), live(ext, null));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.out!.caes[0].state, "unchanged");
    }
  });

  it("compares subnet IDs case-insensitively", () => {
    const r = run(snapshot({ [EXT]: extSubnet, [HYB]: hybSubnet }), live(cae(EXT, extSubnet.toLowerCase()), cae(HYB, hybSubnet.replace("Microsoft.Network", "microsoft.network"))));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out!.caes.map((c: Doc) => c.state), ["unchanged", "unchanged"]);
  });

  it("refuses managed -> vnet and vnet -> managed for an existing External-only CAE, naming the CAE, both networks and the runbook", () => {
    const toVnet = run(snapshot({ [EXT]: extSubnet }), live(cae(EXT, null), null));
    assert.equal(toVnet.code, 1);
    assert.equal(toVnet.out!.caes[0].state, "refused");
    assert.equal(toVnet.out!.refused.length, 1);
    const msg = toVnet.stderr;
    assert.match(msg, /the CAE cae-contoso-ext-nonprod \(External only\) exists on the Azure-managed network \(no VNet\), but instance\.yaml now asks for the subnet \/subscriptions\/00000000-0000-0000-0000-00000000a001\/resourceGroups\/rg-contoso-platform-nonprod\/providers\/Microsoft\.Network\/virtualNetworks\/vnet-contoso-ext-nonprod\/subnets\/snet-contoso-cae-ext-nonprod\./);
    assert.match(msg, /A Container Apps environment's network can't change in place, so the plan stops before validate and what-if\./);
    assert.match(msg, /docs\/runbooks\/change-external-only-network\.md/);
    assert.match(toVnet.stdout, /^FAIL {2}1 existing CAE\(s\) would change their network$/m);
    const toManaged = run(snapshot({ [EXT]: null }), live(cae(EXT, extSubnet), null));
    assert.equal(toManaged.code, 1);
    assert.match(toManaged.stderr, /exists on the subnet \/subscriptions\/.+snet-contoso-cae-ext-nonprod, but instance\.yaml now asks for the Azure-managed network \(no VNet\)/);
  });

  it("refuses an existing hybrid CAE whose VNet or subnet instance.yaml names differently (vnet.create <-> existingVnetId, another existing VNet)", () => {
    const created = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/vnet-contoso-hyb-nonprod/subnets/snet-contoso-cae-hyb-nonprod`;
    const r = run(snapshot({ [EXT]: null, [HYB]: created }), live(cae(EXT, null), cae(HYB, hybSubnet)));
    assert.equal(r.code, 1);
    assert.deepEqual(r.out!.caes.map((c: Doc) => c.state), ["unchanged", "refused"]);
    assert.match(r.stderr, /the CAE cae-contoso-hyb-nonprod \(External with internal access\) exists on the subnet .*vnet-spoke-apps-nonprod.*, but instance\.yaml now asks for the subnet .*vnet-contoso-hyb-nonprod/);
  });

  it("reports a CAE of a mode no longer enabled without comparing it, and an absent one as absent", () => {
    const r = run(snapshot({ [HYB]: hybSubnet }), live(cae(EXT, null), cae(HYB, hybSubnet)));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.out!.caes, [
      { mode: "externalOnly", name: EXT, state: "not-enabled", current: "" },
      { mode: "externalHybrid", name: HYB, state: "unchanged", current: hybSubnet, wanted: hybSubnet },
    ]);
    assert.match(r.stdout, /its mode is no longer enabled \(not compared, not deleted\)/);
    const absent = run(snapshot({ [EXT]: null }), live(null, null));
    assert.equal(absent.code, 0, absent.stderr);
    assert.deepEqual(absent.out!.caes.map((c: Doc) => c.state), ["new", "absent"]);
  });

  it("never quotes a live subnet of an unexpected shape (no logging command reaches the summary)", () => {
    const r = run(snapshot({ [EXT]: null }), live(cae(EXT, "##vso[task.setvariable variable=x]y"), null));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exists on a subnet ID of an unexpected shape, but instance\.yaml now asks for the Azure-managed network/);
    assert.doesNotMatch(r.stderr + r.stdout, /setvariable/);
  });

  it("fails closed on a CAE the plan didn't read, an unresolved subnet, a missing or foreign live entry, or malformed input", () => {
    const foreign = run({ predictedResources: [cae("cae-contoso-ext-nonprod-c02", null)] }, live(null, null));
    assert.equal(foreign.code, 1);
    assert.match(foreign.stderr, /environment\.bicep would deploy the CAE cae-contoso-ext-nonprod-c02, which platform-names\.bicep doesn't list/);
    const unresolved = run(snapshot({ [EXT]: "[format('{0}/subnets/x', variables('vnet'))]" }), live(cae(EXT, null), null));
    assert.equal(unresolved.code, 1);
    assert.match(unresolved.stderr, /the infrastructure subnet is not a resource ID \(an unresolved expression\?\)/);
    const missing = run(snapshot({ [EXT]: null }), [{ mode: "externalOnly", name: EXT, resource: cae(EXT, null) }]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--live has no entry for the CAE cae-contoso-hyb-nonprod/);
    const other = run(snapshot({ [EXT]: null }), [...live(null, null), { mode: "externalOnly", name: "cae-other-ext-nonprod", resource: null }]);
    assert.equal(other.code, 1);
    assert.match(other.stderr, /--live has an entry that isn't one of the listed CAEs/);
    const renamed = run(snapshot({ [EXT]: null }), live(cae("cae-contoso-ext-prod", null), null));
    assert.equal(renamed.code, 1);
    assert.match(renamed.stderr, /the resource read is named otherwise/);
    assert.match(run(snapshot({}), live(null, null), { outputs: {} }).stderr, /--names has no outputs\.managedEnvironments/);
    assert.match(run({}, live(null, null)).stderr, /--snapshot has no predictedResources/);
    assert.match(run(snapshot({}), [], { outputs: { managedEnvironments: [{ mode: "internalOnly", name: "cae-contoso-int-nonprod" }] } }).stderr, /without a known mode/);
    assert.equal(cli(["environment", "cae-network", "--names", writeTmp("n.json", names)]).code, 2);
  });
});
