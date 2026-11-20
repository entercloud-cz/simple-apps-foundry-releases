import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import { validateFile } from "../src/validate.js";
import type { ValidateResult } from "../src/validate.js";
import { validateInstanceDefinition } from "../src/index.js";

/**
 * The rules of `platform validate instance` that the schema can't express (US09.06): unique
 * environment names, references to environments, promotion loops, defaultLanguage in languages,
 * the budget notification count, CIDR ranges (validity, reserved ranges, overlaps, CAE subnet
 * size) and identities.provisioning per environment (US01.03). Each rule has a positive and a
 * negative case on the Contoso example (config/examples).
 */

type Obj = Record<string, unknown>;
const EXAMPLE_FILE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");

const envOf = (doc: Obj, name: string): Obj => {
  const e = (doc["environments"] as Obj[]).find((x) => x["name"] === name);
  assert.ok(e, `environment ${name} in the example`);
  return e;
};
const modesOf = (doc: Obj, name: string): Obj => envOf(doc, name)["networkModes"] as Obj;
const sub = (o: Obj, key: string): Obj => o[key] as Obj;

/** The example changed by `mutate`, validated. */
function validate(mutate: (doc: Obj) => void): ValidateResult {
  return validateFile("instance", instanceFile((doc) => mutate(doc as unknown as Obj)));
}
const msgs = (r: ValidateResult): string[] => (r.checks ?? []).map((c) => `${c.path}: ${c.message}`);
const onlyOk = (r: ValidateResult): void => {
  assert.deepEqual(r.problems, []);
  assert.deepEqual(msgs(r), []);
  assert.equal(r.ok, true);
};

/** A third environment between nonprod and prod: dev -> nonprod -> prod needs the chain nonprod <- dev. */
const withEnvironment = (doc: Obj, e: Obj): void => {
  (doc["environments"] as Obj[]).push(e);
};
const bare = (name: string, extra: Obj = {}): Obj => ({
  name,
  kind: "nonprod",
  subscriptionId: "00000000-0000-0000-0000-00000000a002",
  networkModes: { externalOnly: {} },
  ...extra,
});

describe("instance rules: the examples and fixtures stay valid", () => {
  it("accepts the Contoso example, with and without its optional VNet variant", () => {
    onlyOk(validateFile("instance", EXAMPLE_FILE));
    // The isolated VNet variant of the example's comment, enabled in nonprod.
    onlyOk(
      validate((doc) => {
        const eo = sub(modesOf(doc, "nonprod"), "externalOnly");
        Object.assign(eo, { network: "vnet", vnetAddressSpace: "10.20.0.0/23", caeSubnetPrefix: "10.20.0.0/25", privateEndpointSubnetPrefix: "10.20.1.0/24" });
      }),
    );
  });

  it("accepts the provisioning fixture (a sandbox-like instance with VNet variants)", () => {
    onlyOk(validateFile("instance", join(FIXTURES, "provisioning", "config", "instance.yaml")));
  });
});

describe("instance rules: environments", () => {
  it("environment names are unique", () => {
    const r = validate((doc) => withEnvironment(doc, bare("nonprod")));
    assert.deepEqual(msgs(r), ['environments[2].name: environment name "nonprod" is already used by environments[0]; names are unique.']);
  });

  it("promoteFrom names an environment of the instance, and not the environment itself", () => {
    assert.deepEqual(
      msgs(validate((doc) => (envOf(doc, "prod")["promoteFrom"] = "staging"))),
      ['environments[1].promoteFrom: "staging" is not an environment of this instance (nonprod, prod).'],
    );
    assert.deepEqual(msgs(validate((doc) => (envOf(doc, "prod")["promoteFrom"] = "prod"))), ["environments[1].promoteFrom: environment \"prod\" can't promote from itself."]);
  });

  it("a chain of promotions that ends at a build environment is valid", () => {
    onlyOk(
      validate((doc) => {
        withEnvironment(doc, bare("test", { promoteFrom: "nonprod" }));
        envOf(doc, "prod")["promoteFrom"] = "test";
      }),
    );
  });

  it("promoteFrom loops are reported once per loop, at the environment listed first", () => {
    const loop2 = validate((doc) => (envOf(doc, "nonprod")["promoteFrom"] = "prod"));
    assert.deepEqual(msgs(loop2), ["environments[0].promoteFrom: promoteFrom forms a loop (nonprod -> prod -> nonprod); a promotion chain ends at a build environment, one without promoteFrom."]);

    // A longer loop, listed in a different order, and an environment that only leads into it.
    const loop3 = validate((doc) => {
      withEnvironment(doc, bare("qa", { promoteFrom: "prod" }));
      envOf(doc, "nonprod")["promoteFrom"] = "qa";
    });
    assert.deepEqual(msgs(loop3), ["environments[0].promoteFrom: promoteFrom forms a loop (nonprod -> qa -> prod -> nonprod); a promotion chain ends at a build environment, one without promoteFrom."]);

    const feeder = validate((doc) => {
      envOf(doc, "nonprod")["promoteFrom"] = "prod";
      withEnvironment(doc, bare("edge", { promoteFrom: "nonprod" }));
    });
    assert.deepEqual(msgs(feeder).length, 1, msgs(feeder).join("\n"));
    assert.match(msgs(feeder)[0] ?? "", /^environments\[0\]\.promoteFrom: promoteFrom forms a loop \(nonprod -> prod -> nonprod\)/);
  });

  it("portal.hostEnvironment names an environment", () => {
    assert.deepEqual(msgs(validate((doc) => (sub(doc, "portal")["hostEnvironment"] = "staging"))), ['portal.hostEnvironment: "staging" is not an environment of this instance (nonprod, prod).']);
  });

  it("portal.network.routeTableId needs a hub on the host environment", () => {
    const routeTable = "/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-network-prod/providers/Microsoft.Network/routeTables/rt-portal";
    // With the hub (prod has one): fine.
    onlyOk(validate((doc) => (sub(sub(doc, "portal"), "network")["routeTableId"] = routeTable)));
    // Without it (the host environment keeps no connected mode, so the schema doesn't ask for one).
    const r = validate((doc) => {
      const prod = envOf(doc, "prod");
      delete prod["hub"];
      delete sub(prod, "networkModes")["externalHybrid"];
      sub(sub(doc, "portal"), "network")["routeTableId"] = routeTable;
    });
    assert.deepEqual(msgs(r), [
      'portal.network.routeTableId: the portal\'s host environment "prod" has no hub (environments[1].hub), and a route table through the hub needs one: the portal VNet is then peered to it. Add the hub or remove routeTableId.',
    ]);
  });
});

describe("instance rules: references to environments", () => {
  const systems = (doc: Obj): Obj[] => sub(doc, "network")["internalSystems"] as Obj[];

  it("internal systems: allowedEnvironments and firewall rules name environments", () => {
    const r = validate((doc) => {
      const s = systems(doc)[0]!;
      (s["allowedEnvironments"] as string[]).push("staging");
      (s["firewallRules"] as Obj[]).push({ environment: "qa", networkMode: "externalHybrid", status: "requested" });
    });
    assert.deepEqual(msgs(r), [
      'network.internalSystems[0].allowedEnvironments[2]: "staging" is not an environment of this instance (nonprod, prod).',
      'network.internalSystems[0].firewallRules[2].environment: "qa" is not an environment of this instance (nonprod, prod).',
    ]);
  });

  it("internal system IDs are unique", () => {
    const r = validate((doc) => systems(doc).push({ ...structuredClone(systems(doc)[0]!), name: "A second copy" }));
    assert.deepEqual(msgs(r), ['network.internalSystems[3].id: system ID "sql-inventory" is already used by network.internalSystems[0]; IDs are unique.']);
  });

  it("DNS zones: allowedEnvironments name environments, each once", () => {
    const zones = (doc: Obj): Obj[] => sub(doc, "dns")["zones"] as Obj[];
    onlyOk(validate((doc) => (zones(doc)[0]!["allowedEnvironments"] = ["nonprod", "prod"])));
    const r = validate((doc) => (zones(doc)[0]!["allowedEnvironments"] = ["prod", "staging", "prod"]));
    assert.deepEqual(msgs(r), [
      'dns.zones[0].allowedEnvironments[1]: "staging" is not an environment of this instance (nonprod, prod).',
      'dns.zones[0].allowedEnvironments[2]: environment "prod" is listed more than once for this zone.',
    ]);
  });
});

describe("instance rules: language and budgets", () => {
  it("defaultLanguage is one of languages, also when it is the schema default", () => {
    onlyOk(validate((doc) => Object.assign(sub(doc, "locale"), { defaultLanguage: "cs", languages: ["cs"] })));
    assert.deepEqual(msgs(validate((doc) => Object.assign(sub(doc, "locale"), { defaultLanguage: "cs", languages: ["en"] }))), [
      'locale.defaultLanguage: the default language "cs" is not one of locale.languages (en); add it there or choose another default language.',
    ]);
    const defaulted = (doc: Obj): void => {
      delete sub(doc, "locale")["defaultLanguage"];
      sub(doc, "locale")["languages"] = ["cs"];
    };
    assert.deepEqual(msgs(validate(defaulted)), [
      'locale.languages: the default language "en" (the default) is not one of locale.languages (cs); add it there or set locale.defaultLanguage.',
    ]);
  });

  it("at most 5 budget notifications, actual and forecast together", () => {
    const set = (actual: number[], forecast?: number[]) => (doc: Obj) => {
      const b = sub(doc, "budgets");
      b["notifyAtPercent"] = actual;
      if (forecast) b["forecastNotifyAtPercent"] = forecast;
      else delete b["forecastNotifyAtPercent"];
    };
    onlyOk(validate(set([50, 80, 100, 120], [100]))); // 4 + 1
    onlyOk(validate(set([80, 100, 120], [100, 120]))); // 3 + 2
    onlyOk(validate(set([80, 100, 120, 150]))); // 4 + the default forecast threshold
    assert.deepEqual(msgs(validate(set([50, 80, 100, 120], [100, 120]))), [
      "budgets.forecastNotifyAtPercent: notifyAtPercent (4) and forecastNotifyAtPercent (2) make 6 budget notifications; Azure allows at most 5 per budget (ADR-0017). Remove some.",
    ]);
  });
});

describe("instance rules: network ranges", () => {
  const vnetNonprod = (doc: Obj, fields: Obj): void => {
    Object.assign(sub(modesOf(doc, "nonprod"), "externalOnly"), { network: "vnet", vnetAddressSpace: "10.20.0.0/23", caeSubnetPrefix: "10.20.0.0/25", privateEndpointSubnetPrefix: "10.20.1.0/24" }, fields);
  };
  const hybrid = (doc: Obj, env: string): Obj => sub(modesOf(doc, env), "externalHybrid");
  const portalNet = (doc: Obj): Obj => sub(sub(doc, "portal"), "network");

  it("a range is a valid IPv4 range: octets up to 255, prefix up to 32, no host bits", () => {
    assert.deepEqual(msgs(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "10.20.0.300/23" }))), [
      'environments[0].networkModes.externalOnly.vnetAddressSpace: "10.20.0.300/23" is not an IPv4 range: an address part is above 255.',
    ]);
    assert.deepEqual(msgs(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "10.20.0.0/33" }))), [
      'environments[0].networkModes.externalOnly.vnetAddressSpace: "10.20.0.0/33" is not an IPv4 range: the prefix length is above 32.',
    ]);
    assert.deepEqual(msgs(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "10.20.0.1/23" }))), [
      'environments[0].networkModes.externalOnly.vnetAddressSpace: "10.20.0.1/23" has host bits set; the network address of that range is 10.20.0.0/23.',
    ]);
    // The same for the other sections that hold ranges: connected spokes, the portal and internal systems.
    assert.deepEqual(msgs(validate((doc) => (hybrid(doc, "nonprod")["caeSubnetPrefix"] = "10.21.0.7/25"))), [
      'environments[0].networkModes.externalHybrid.caeSubnetPrefix: "10.21.0.7/25" has host bits set; the network address of that range is 10.21.0.0/25.',
    ]);
    assert.deepEqual(msgs(validate((doc) => (portalNet(doc)["privateEndpointSubnetPrefix"] = "10.40.1.0/99"))), [
      'portal.network.privateEndpointSubnetPrefix: "10.40.1.0/99" is not an IPv4 range: the prefix length is above 32.',
    ]);
    // A range that isn't even digits and dots is a schema problem: the rules run on a schema-valid file only.
    const malformed = validate((doc) => (((sub(doc, "network")["internalSystems"] as Obj[])[2]!["endpoints"] as Obj[])[0]!["cidr"] = "10.60.4.0/20x"));
    assert.ok(malformed.problems.length > 0);
    assert.deepEqual(malformed.checks, []);
    assert.deepEqual(msgs(validate((doc) => (((sub(doc, "network")["internalSystems"] as Obj[])[2]!["endpoints"] as Obj[])[0]!["cidr"] = "10.60.4.1/27"))), [
      'network.internalSystems[2].endpoints[0].cidr: "10.60.4.1/27" has host bits set; the network address of that range is 10.60.4.0/27.',
    ]);
  });

  it("no range overlaps a range that Container Apps reserves", () => {
    for (const [reserved, overlapped] of [
      ["172.30.0.0/23", "172.30.0.0/16"],
      ["172.31.255.0/24", "172.31.0.0/16"],
      ["169.254.10.0/24", "169.254.0.0/16"],
      ["192.0.2.0/24", "192.0.2.0/24"],
      ["100.100.64.0/24", "100.100.0.0/17"],
      ["100.100.130.0/24", "100.100.128.0/19"],
    ] as const) {
      const r = validate((doc) => vnetNonprod(doc, { vnetAddressSpace: reserved, caeSubnetPrefix: reserved.replace(/\.0\/\d+$/, ".0/25"), privateEndpointSubnetPrefix: reserved.replace(/\.0\/\d+$/, ".128/25") }));
      assert.deepEqual(
        msgs(r),
        [`environments[0].networkModes.externalOnly.vnetAddressSpace: ${reserved} overlaps ${overlapped}, which Container Apps reserves for itself; choose another range (network-modes.md#sizing).`],
        `${reserved}: the subnets inside it are not reported again`,
      );
    }
    // Next to a reserved range is fine.
    onlyOk(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "172.29.0.0/23", caeSubnetPrefix: "172.29.0.0/25", privateEndpointSubnetPrefix: "172.29.1.0/24" })));
    onlyOk(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "100.101.0.0/23", caeSubnetPrefix: "100.101.0.0/25", privateEndpointSubnetPrefix: "100.101.1.0/24" })));
  });

  it("a subnet of an existing VNet and the portal's CAE subnet are checked against the reserved ranges too", () => {
    assert.deepEqual(msgs(validate((doc) => (hybrid(doc, "prod")["caeSubnetPrefix"] = "172.31.4.0/25"))), [
      "environments[1].networkModes.externalHybrid.caeSubnetPrefix: 172.31.4.0/25 overlaps 172.31.0.0/16, which Container Apps reserves for itself; choose another range (network-modes.md#sizing).",
    ]);
    // A range that spans several reserved ranges names all of them.
    assert.match(
      msgs(validate((doc) => Object.assign(portalNet(doc), { vnetAddressSpace: "100.64.0.0/10", caeSubnetPrefix: "100.64.0.0/25", privateEndpointSubnetPrefix: "100.64.1.0/24" })))[0] ?? "",
      /^portal\.network\.vnetAddressSpace: 100\.64\.0\.0\/10 overlaps 100\.100\.0\.0\/17, 100\.100\.128\.0\/19, 100\.100\.160\.0\/19, 100\.100\.192\.0\/19, which Container Apps reserves/,
    );
  });

  it("subnets of a VNet the platform creates lie inside its address space, and don't overlap each other", () => {
    assert.deepEqual(msgs(validate((doc) => vnetNonprod(doc, { caeSubnetPrefix: "10.22.0.0/25" }))), [
      "environments[0].networkModes.externalOnly.caeSubnetPrefix: 10.22.0.0/25 is outside the address space 10.20.0.0/23 of the External-only VNet of nonprod (environments[0].networkModes.externalOnly.vnetAddressSpace); a subnet lies inside its VNet.",
    ]);
    assert.deepEqual(msgs(validate((doc) => vnetNonprod(doc, { privateEndpointSubnetPrefix: "10.20.0.64/26" }))), [
      "environments[0].networkModes.externalOnly.privateEndpointSubnetPrefix: 10.20.0.64/26 overlaps the CAE subnet 10.20.0.0/25 (environments[0].networkModes.externalOnly.caeSubnetPrefix); the CAE subnet is delegated to Container Apps and used by nothing else, so private endpoints need a subnet of their own.",
    ]);
    // Existing VNet: its address space isn't in instance.yaml, so only the overlap of the two subnets can be seen.
    assert.deepEqual(msgs(validate((doc) => (hybrid(doc, "nonprod")["privateEndpointSubnetPrefix"] = "10.21.0.0/24"))), [
      "environments[0].networkModes.externalHybrid.privateEndpointSubnetPrefix: 10.21.0.0/24 overlaps the CAE subnet 10.21.0.0/25 (environments[0].networkModes.externalHybrid.caeSubnetPrefix); the CAE subnet is delegated to Container Apps and used by nothing else, so private endpoints need a subnet of their own.",
    ]);
    // A VNet the platform creates for a connected mode: the same rules.
    assert.deepEqual(
      msgs(
        validate((doc) => {
          const m = hybrid(doc, "nonprod");
          m["vnet"] = { create: { addressSpace: "10.21.0.0/24" } };
        }),
      ),
      [
        "environments[0].networkModes.externalHybrid.privateEndpointSubnetPrefix: 10.21.1.0/24 is outside the address space 10.21.0.0/24 of the externalHybrid VNet of nonprod (environments[0].networkModes.externalHybrid.vnet.create.addressSpace); a subnet lies inside its VNet.",
      ],
    );
  });

  it("no two VNets overlap, whether the platform creates them or the network team did", () => {
    // An External-only spoke over the nonprod hybrid subnets.
    assert.deepEqual(msgs(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "10.20.0.0/15", privateEndpointSubnetPrefix: "10.20.1.0/24" }))), [
      "environments[0].networkModes.externalHybrid.caeSubnetPrefix: 10.21.0.0/25 (externalHybrid VNet of nonprod) overlaps 10.20.0.0/15 (External-only VNet of nonprod, environments[0].networkModes.externalOnly.vnetAddressSpace); the ranges of one instance don't overlap, peered or not, so a later peering or hub connection stays possible.",
      "environments[0].networkModes.externalHybrid.privateEndpointSubnetPrefix: 10.21.1.0/24 (externalHybrid VNet of nonprod) overlaps 10.20.0.0/15 (External-only VNet of nonprod, environments[0].networkModes.externalOnly.vnetAddressSpace); the ranges of one instance don't overlap, peered or not, so a later peering or hub connection stays possible.",
    ]);
    // The portal's VNet over prod's connected spoke.
    const portal = validate((doc) => Object.assign(portalNet(doc), { vnetAddressSpace: "10.30.0.0/15", caeSubnetPrefix: "10.30.0.0/25", privateEndpointSubnetPrefix: "10.30.1.0/24" }));
    assert.deepEqual(
      msgs(portal).map((m) => m.split(": ")[0]),
      ["portal.network.vnetAddressSpace"],
    );
    assert.match(msgs(portal)[0] ?? "", /10\.30\.0\.0\/15 \(portal VNet\) overlaps 10\.31\.0\.0\/25 \(externalHybrid VNet of prod, environments\[1\]\.networkModes\.externalHybrid\.caeSubnetPrefix\)/);
    // Two existing VNets that use the same subnet.
    assert.deepEqual(
      msgs(validate((doc) => (hybrid(doc, "prod")["caeSubnetPrefix"] = "10.21.0.0/25"))),
      [
        "environments[1].networkModes.externalHybrid.caeSubnetPrefix: 10.21.0.0/25 (externalHybrid VNet of prod) overlaps 10.21.0.0/25 (externalHybrid VNet of nonprod, environments[0].networkModes.externalHybrid.caeSubnetPrefix); the ranges of one instance don't overlap, peered or not, so a later peering or hub connection stays possible.",
      ],
    );
    // Neighbours that don't overlap are fine.
    onlyOk(validate((doc) => vnetNonprod(doc, { vnetAddressSpace: "10.20.0.0/24", caeSubnetPrefix: "10.20.0.0/25", privateEndpointSubnetPrefix: "10.20.0.128/25" })));
  });

  it("the CAE subnet of a prod environment is a /26 or larger; nonprod and the portal may use a /27", () => {
    onlyOk(validate((doc) => (hybrid(doc, "nonprod")["caeSubnetPrefix"] = "10.21.0.0/27")));
    onlyOk(validate((doc) => Object.assign(portalNet(doc), { caeSubnetPrefix: "10.40.0.0/27" })));
    onlyOk(validate((doc) => (hybrid(doc, "prod")["caeSubnetPrefix"] = "10.31.0.0/26")));
    assert.deepEqual(msgs(validate((doc) => (hybrid(doc, "prod")["caeSubnetPrefix"] = "10.31.0.0/27"))), [
      "environments[1].networkModes.externalHybrid.caeSubnetPrefix: the CAE subnet of a prod environment is a /26 or larger, and 10.31.0.0/27 holds about 90 replicas in all (a /26 about 250, the default /25 about 570). A subnet can't be resized once its CAE exists; /27 is for pilots only (network-modes.md#sizing).",
    ]);
    // The External-only VNet variant of prod, too (kind decides, not the name).
    const prodVnet = validate((doc) => {
      Object.assign(sub(modesOf(doc, "prod"), "externalOnly"), { network: "vnet", vnetAddressSpace: "10.32.0.0/24", caeSubnetPrefix: "10.32.0.0/27", privateEndpointSubnetPrefix: "10.32.0.128/25" });
    });
    assert.match(msgs(prodVnet)[0] ?? "", /^environments\[1\]\.networkModes\.externalOnly\.caeSubnetPrefix: the CAE subnet of a prod environment is a \/26 or larger/);
  });

  it("environments on the managed network have no ranges to check", () => {
    onlyOk(
      validate((doc) => {
        for (const e of doc["environments"] as Obj[]) {
          e["networkModes"] = { externalOnly: { network: "managed" } };
          delete e["hub"];
        }
      }),
    );
  });
});

describe("instance rules: identities.provisioning per environment", () => {
  const prov = (doc: Obj): Obj => sub(sub(doc, "identities"), "provisioning");
  const id = (subscription: string, env: string): Obj => ({
    resourceId: `/subscriptions/${subscription}/resourceGroups/rg-contoso-identities-${env}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-provisioning-${env}`,
  });

  it("the example carries one per environment, and the key and the subscription are checked", () => {
    onlyOk(validateFile("instance", EXAMPLE_FILE));
    assert.deepEqual(msgs(validate((doc) => (prov(doc)["staging"] = id("00000000-0000-0000-0000-00000000a001", "staging")))), [
      'identities.provisioning.staging: "staging" is not an environment of this instance (nonprod, prod). The key names the environment the identity provisions.',
    ]);
    assert.deepEqual(msgs(validate((doc) => (prov(doc)["prod"] = id("00000000-0000-0000-0000-00000000a001", "prod")))), [
      'identities.provisioning.prod.resourceId: the identity is in subscription 00000000-0000-0000-0000-00000000a001, but environment "prod" is in subscription 00000000-0000-0000-0000-00000000b001; the Azure provisioning identity of an environment lives in that environment\'s subscription (ADR-0031).',
    ]);
  });

  it("the subscription is compared without case", () => {
    onlyOk(validate((doc) => (prov(doc)["prod"] = id("00000000-0000-0000-0000-00000000B001", "prod"))));
  });

  it("is optional, and may name some environments only", () => {
    onlyOk(validate((doc) => delete sub(doc, "identities")["provisioning"]));
    onlyOk(validate((doc) => delete prov(doc)["nonprod"]));
  });

  it("the schema takes a map of references, not the single reference of older drafts", () => {
    const old = validate((doc) => (sub(doc, "identities")["provisioning"] = id("00000000-0000-0000-0000-00000000a001", "nonprod")));
    assert.equal(old.ok, false);
    assert.ok(old.problems.some((p) => p.path === "identities.provisioning.resourceId" && /unknown property "resourceId"/.test(p.message)), JSON.stringify(old.problems));
    assert.deepEqual(old.checks, [], "semantic rules run only on a schema-valid file");
    const noId = validate((doc) => (prov(doc)["prod"] = {}));
    assert.ok(noId.problems.some((p) => p.path === "identities.provisioning.prod" && /resourceId/.test(p.message)), JSON.stringify(noId.problems));
  });
});

describe("instance rules: where they are reported", () => {
  it("prints the line of the offending range, exits 1, and the library gives the same problem", () => {
    const text = readFileSync(EXAMPLE_FILE, "utf8").replace("caeSubnetPrefix: 10.31.0.0/25", "caeSubnetPrefix: 10.21.0.0/25");
    const file = join(tmp("pc-inst-"), "instance.yaml");
    writeFileSync(file, text);
    const lines = text.split("\n").flatMap((l, i) => (l.includes("caeSubnetPrefix: 10.21.0.0/25") ? [i + 1] : []));
    assert.equal(lines.length, 2, "nonprod's subnet and the one now given to prod");

    const out = cli(["validate", "instance", file]);
    assert.equal(out.code, 1);
    assert.ok(
      out.stdout.includes(`line ${lines[1]}: environments[1].networkModes.externalHybrid.caeSubnetPrefix: 10.21.0.0/25 (externalHybrid VNet of prod) overlaps 10.21.0.0/25`),
      out.stdout,
    );

    const lib = validateInstanceDefinition(text);
    assert.equal(lib.ok, false);
    assert.deepEqual(
      lib.problems.map((p) => p.path),
      ["environments[1].networkModes.externalHybrid.caeSubnetPrefix"],
    );
  });
});
