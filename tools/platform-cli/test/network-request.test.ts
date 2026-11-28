import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import {
  EGRESS_BASELINE,
  egressBaselineMarkdownRows,
  firewallRuleOf,
  hubConnectionRequest,
  hubPeeringName,
  NetworkRequestError,
  platformResourceGroupName,
  PRIVATE_DNS_ZONES,
  privateDnsResourceGroupName,
  privateEndpointSubnetName,
  spokeVnetName,
  systemAccessRequest,
  systemsOffered,
} from "../src/network-request.js";
import type { RequestApp, RequestInstance } from "../src/network-request.js";
import { parseInstanceText } from "../src/provisioning/model.js";
import { cli, REPO_ROOT, tmp, write } from "./helpers.js";

/**
 * The network team's texts (ADR-0027 amendment 2026-11-12, src/network-request.ts): the baseline
 * table of network-modes.md against EGRESS_BASELINE, the names against the shared naming vectors,
 * the owner's request for an internal system, the hub connection text, and `platform network request`.
 */
const exampleText = readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8");
const instance = (): RequestInstance => parseInstanceText(exampleText) as unknown as RequestInstance;
const DATE = new Date("2026-11-12T10:00:00Z");

const app: RequestApp = {
  slug: "hotel-inventory",
  title: "Hotel Inventory",
  owner: { name: "Jana Novakova", email: "jana.novakova@contoso.com" },
  deputy: { name: "Petr Kral", email: "petr.kral@contoso.com" },
  environments: { nonprod: { networkMode: "externalOnly" }, prod: { networkMode: "externalHybrid" } },
};
const hybridApp: RequestApp = { ...app, environments: { nonprod: { networkMode: "externalHybrid" }, prod: { networkMode: "externalHybrid" } } };

const problem = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof NetworkRequestError) return e.code;
    throw e;
  }
  assert.fail("no NetworkRequestError");
};

describe("the standing egress baseline", () => {
  it("network-modes.md's table is EGRESS_BASELINE (egressBaselineMarkdownRows)", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "architecture", "network-modes.md"), "utf8").split("\n");
    const header = doc.findIndex((l) => l === "| Purpose | FQDNs | Source (Microsoft Learn) |");
    assert.ok(header > 0, "the baseline table's header is in network-modes.md");
    const rows: string[] = [];
    for (let i = header + 2; doc[i]?.startsWith("|"); i++) rows.push(doc[i]!);
    assert.deepEqual(rows, egressBaselineMarkdownRows());
  });

  it("every rule has a purpose in both languages, FQDNs and a source", () => {
    for (const r of EGRESS_BASELINE) {
      assert.ok(r.purpose.en && r.purpose.cs && r.fqdns.length > 0 && r.sources.length > 0, r.id);
      for (const f of r.fqdns) assert.match(f, /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, f);
    }
    assert.equal(new Set(EGRESS_BASELINE.map((r) => r.id)).size, EGRESS_BASELINE.length);
  });

  it("the private DNS zones are those environment.bicep creates per spoke (vault, postgres, sql, blob)", () => {
    const bicep = readFileSync(join(REPO_ROOT, "infra", "platform", "environment.bicep"), "utf8");
    const services = /var privateDnsServices = \[([^\]]*)\]/.exec(bicep)?.[1]?.match(/'(\w+)'/g)?.map((s) => s.slice(1, -1));
    assert.deepEqual(services, ["vault", "postgres", "sql", "blob"]);
    const naming = readFileSync(join(REPO_ROOT, "infra", "modules", "naming", "naming.bicep"), "utf8");
    assert.ok(naming.includes(`'${PRIVATE_DNS_ZONES[0]}'`) && naming.includes(`'${PRIVATE_DNS_ZONES[1]}'`));
    assert.ok(naming.includes("'privatelink${environment().suffixes.sqlServerHostname}'") && naming.includes("'privatelink.blob.${environment().suffixes.storage}'"));
    assert.deepEqual(PRIVATE_DNS_ZONES.slice(2), ["privatelink.database.windows.net", "privatelink.blob.core.windows.net"]);
  });
});

describe("names against the shared naming vectors", () => {
  const vectors = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "tests", "naming-vectors.json"), "utf8")) as { cases: { input: { prefix: string; env: string }; names: Record<string, string> }[] };
  for (const c of vectors.cases) {
    it(`${c.input.prefix}/${c.input.env}`, () => {
      const { prefix, env } = c.input;
      assert.equal(spokeVnetName(prefix, "externalHybrid", env), c.names.vnetHyb);
      assert.equal(privateEndpointSubnetName(prefix, "externalHybrid", env), c.names.snetPepHyb);
      assert.equal(hubPeeringName(prefix, "externalHybrid", env), c.names.hubPeeringHyb);
      assert.equal(privateDnsResourceGroupName(prefix, "externalHybrid", env), c.names.privateDnsResourceGroupHyb);
      assert.equal(platformResourceGroupName(prefix, env), c.names.platformResourceGroup);
    });
  }
  it("refuses an invalid prefix", () => assert.equal(problem(() => spokeVnetName("Contoso", "externalHybrid", "prod")), "input"));
});

describe("the catalogue's rule state", () => {
  it("per environment x mode; no entry is not requested", () => {
    const [sql, , hr] = instance().network!.internalSystems!;
    assert.deepEqual(firewallRuleOf(sql!, "nonprod", "externalHybrid"), { status: "active", reference: "CHG-1042" });
    assert.deepEqual(firewallRuleOf(sql!, "prod", "externalHybrid"), { status: "requested", reference: "CHG-1043" });
    assert.deepEqual(firewallRuleOf(sql!, "prod", "internalOnly"), { status: "notRequested" });
    assert.deepEqual(firewallRuleOf(hr!, "prod", "externalHybrid"), { status: "notRequested" });
    assert.deepEqual(
      systemsOffered(instance(), "nonprod", "externalHybrid").map((s) => s.id),
      ["sql-inventory", "smtp-relay"],
    );
    assert.deepEqual(systemsOffered(instance(), "nonprod", "externalOnly"), []);
  });
});

describe("the app owner's request for an internal system", () => {
  const base = { instance: instance(), app, environment: "prod", system: "hr-api", justification: "Shows who runs each hotel.\nRead-only.", requestedBy: "Jana Novakova", date: DATE, lang: "en" as const };

  it("names the app, the source subnet of the whole environment, the firewall, the destination and the process", () => {
    const { text, fileName, rule } = systemAccessRequest(base);
    assert.equal(fileName, "firewall-request-hotel-inventory-prod-hr-api.txt");
    assert.deepEqual(rule, { status: "notRequested" });
    const lines = text.split("\n");
    assert.equal(lines[0], "Firewall rule request: Hotel Inventory (prod) to HR API (Azure-hosted)");
    for (const s of [
      "How to send it: Service desk queue 'Network – firewall rules'",
      "App:               Hotel Inventory (hotel-inventory)",
      "Owner:             Jana Novakova <jana.novakova@contoso.com>",
      "Deputy:            Petr Kral <petr.kral@contoso.com>",
      "Asked by:          Jana Novakova",
      "Environment:       prod (production)",
      "Network mode:      Internet + internal systems (externalHybrid)",
      "Subnet:            10.31.0.0/25 (subnet of the Container Apps environment cae-contoso-hyb-prod)",
      "Next hop:          the hub firewall 10.0.1.4 (route table rt-to-firewall)",
      "System:            HR API (Azure-hosted) (catalogue ID hr-api)",
      "Endpoints:         10.60.4.0/27  TCP 443",
      "Location:          Azure",
      "Connectivity:      Azure, peering with the hub (from the hub firewall)",
      "System owner:      HR Systems (People & Culture IT) <hr-systems@contoso.com>",
      "Approval:          The system owner must approve this access before the rule is opened.",
      "  Shows who runs each hotel.",
      "  Read-only.",
      "  Rule from prod (Internet + internal systems (externalHybrid)): not requested yet",
      "Written by SAF on 2026-11-12. The platform itself changes no firewall rule.",
    ])
      assert.ok(text.includes(s), s);
    assert.match(text, /The rule applies to the whole Container Apps environment, not to this app alone\. Every app in prod/);
    // An IP range: no host name to resolve.
    assert.doesNotMatch(text, /Host names:/);
  });

  it("an earlier request, host names, a system without the owner's approval and the Czech text", () => {
    const requested = systemAccessRequest({ ...base, system: "sql-inventory" }).text;
    assert.match(requested, /Rule from prod \(.*\): already requested \(reference CHG-1043\)\n {2}The rule was asked for already: this request adds this app's reason\./);
    assert.match(requested, /Host names: {8}must resolve through the spoke's DNS servers \(10\.0\.0\.4, 10\.0\.0\.5\)\./);
    const smtp = systemAccessRequest({ ...base, instance: (() => {
      const i = instance();
      i.network!.internalSystems![1]!.firewallRules = [];
      return i;
    })(), system: "smtp-relay" }).text;
    assert.match(smtp, /Endpoints: {9}10\.50\.0\.25 {2}TCP 25, 587/);
    assert.match(smtp, /The catalogue says apps need no approval of the system owner/);
    const cs = systemAccessRequest({ ...base, lang: "cs" }).text;
    assert.equal(cs.split("\n")[0], "Žádost o pravidlo firewallu: Hotel Inventory (prod) → HR API (Azure-hosted)");
    assert.match(cs, /Pravidlo platí pro celé prostředí Container Apps, ne jen pro tuhle aplikaci\./);
    assert.match(cs, /Vlastník systému musí s přístupem souhlasit/);
    assert.match(cs, /Napsal SAF 12\. 11\. 2026\./);
  });

  it("free text can't add control characters or break the layout", () => {
    const { text } = systemAccessRequest({ ...base, justification: "a\u001b[31m red\r\n\r\n\r\nb\u0007", requestedBy: "Eve\nInjected: line" });
    assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(text));
    assert.match(text, /Asked by: {10}Eve Injected: line\n/);
    assert.match(text, /\n {2}a \[31m red\n\n {2}b\n/);
  });

  it("refuses what isn't a request: another environment, a mode without internal systems, the catalogue, an open rule, no reason", () => {
    assert.equal(problem(() => systemAccessRequest({ ...base, environment: "test" })), "environment");
    assert.equal(problem(() => systemAccessRequest({ ...base, environment: "nonprod" })), "mode");
    assert.equal(problem(() => systemAccessRequest({ ...base, system: "nope" })), "system");
    assert.equal(problem(() => systemAccessRequest({ ...base, app: hybridApp, environment: "nonprod", system: "hr-api" })), "notOffered");
    assert.equal(problem(() => systemAccessRequest({ ...base, app: hybridApp, environment: "nonprod", system: "sql-inventory" })), "active");
    assert.equal(problem(() => systemAccessRequest({ ...base, justification: "  \n " })), "input");
    assert.equal(problem(() => systemAccessRequest({ ...base, justification: "x".repeat(1001) })), "input");
    const noHybrid = instance();
    delete (noHybrid.environments[1]!.networkModes as Record<string, unknown>).externalHybrid;
    assert.equal(problem(() => systemAccessRequest({ ...base, instance: noHybrid })), "notConfigured");
  });

  it("without a named process, the text says to ask the platform team", () => {
    const i = instance();
    delete i.environments[1]!.networkModes!.externalHybrid!.egressAllowListProcess;
    assert.match(systemAccessRequest({ ...base, instance: i }).text, /How to send it: your organisation hasn't named a process yet/);
  });
});

describe("the network team's text for connecting an environment to the hub", () => {
  const created = (): RequestInstance => {
    const doc = parse(exampleText) as { environments: { name: string; networkModes: { externalHybrid: Record<string, unknown> } }[] };
    const hyb = doc.environments.find((e) => e.name === "prod")!.networkModes.externalHybrid;
    hyb.vnet = { create: { addressSpace: "10.31.0.0/23", useRemoteGateways: true } };
    delete hyb.dnsServers;
    hyb.egressBaseline = { status: "requested", reference: "CHG-2001" };
    return doc as unknown as RequestInstance;
  };

  it("an existing VNet: the platform's two subnets, both peerings the network team's, DNS servers with the open point", () => {
    const { text, fileName } = hubConnectionRequest({ instance: instance(), environment: "nonprod", date: DATE, lang: "en" });
    assert.equal(fileName, "network-request-contoso-nonprod-hyb.txt");
    assert.equal(text.split("\n")[0], "Network request: connect nonprod (Internet + internal systems) to the hub");
    for (const s of [
      "Subscription:               00000000-0000-0000-0000-00000000a001",
      "Region:                     westeurope",
      "Container Apps environment: cae-contoso-hyb-nonprod (resource group rg-contoso-platform-nonprod)",
      "VNet: /subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-network-nonprod/providers/Microsoft.Network/virtualNetworks/vnet-spoke-apps-nonprod (yours",
      "snet-contoso-cae-hyb-nonprod  10.21.0.0/25",
      "snet-contoso-pep-hyb-nonprod  10.21.1.0/24",
      "Both directions are yours, as the VNet is: the platform creates no peering for an existing VNet.",
      "Default route:              0.0.0.0/0 to the firewall 10.0.1.4 (next hop: virtual appliance)",
      "DNS servers:                10.0.0.4, 10.0.0.5 (set on the spoke VNet)",
      "which the platform creates in rg-contoso-dns-hyb-nonprod and links to the spoke VNet:",
      "        privatelink.vaultcore.azure.net",
      "Source:                     10.21.0.0/25 (the whole subnet of the Container Apps environment)",
      "State:                      active (reference CHG-1101)",
      "Accepted risk: *.azurecr.io and *.blob.core.windows.net also match",
      "    - Inventory database (on-premises SQL Server) (sql-inventory): rule open",
    ])
      assert.ok(text.includes(s), s);
    assert.match(text, /Open point: with your own DNS servers.*\(ADR-0028, deferred on 2026-11-01\)/);
    for (const r of EGRESS_BASELINE) assert.ok(text.includes(r.fqdns.join(", ")), r.id);
    assert.doesNotMatch(text, /peer-contoso/);
  });

  it("a VNet the platform creates: its name and address space, the spoke-to-hub peering, gateway transit, Azure-provided DNS", () => {
    const { text } = hubConnectionRequest({ instance: created(), environment: "prod", date: DATE, lang: "en", requestedBy: "Ada Admin" });
    for (const s of [
      "VNet: vnet-contoso-hyb-prod in rg-contoso-platform-prod, created by the platform, address space 10.31.0.0/23",
      "peer-contoso-hyb-prod-to-hub, created by the platform: virtual network access allowed, forwarded traffic allowed, gateway transit off, use remote gateways on.",
      "created by the network team (the hub is yours) once the platform has created the spoke VNet: virtual network access allowed, forwarded traffic allowed, gateway transit allowed",
      "DNS servers:                Azure-provided DNS",
      "State:                      requested (reference CHG-2001)",
      "    - HR API (Azure-hosted) (hr-api): rule not requested yet",
      "on 2026-11-12 for Ada Admin.",
    ])
      assert.ok(text.includes(s), s);
    assert.doesNotMatch(text, /Open point: with your own DNS servers/);
    const cs = hubConnectionRequest({ instance: created(), environment: "prod", date: DATE, lang: "cs" }).text;
    assert.equal(cs.split("\n")[0], "Žádost o síť: připojit prod (Z internetu + interní systémy) k hubu");
    assert.match(cs, /Přijaté riziko: \*\.azurecr\.io a \*\.blob\.core\.windows\.net/);
    assert.match(cs, /Registry aplikací: stahování vrstev \(datový endpoint\):/);
  });

  it("refuses an unknown environment, one without the mode and one without a hub", () => {
    assert.equal(problem(() => hubConnectionRequest({ instance: instance(), environment: "qa", date: DATE, lang: "en" })), "environment");
    const i = instance();
    delete (i.environments[0]!.networkModes as Record<string, unknown>).externalHybrid;
    assert.equal(problem(() => hubConnectionRequest({ instance: i, environment: "nonprod", date: DATE, lang: "en" })), "notConfigured");
    const h = instance();
    delete h.environments[0]!.hub;
    assert.equal(problem(() => hubConnectionRequest({ instance: h, environment: "nonprod", date: DATE, lang: "en" })), "noHub");
    assert.equal(problem(() => hubConnectionRequest({ instance: instance(), environment: "nonprod", mode: "internalOnly", date: DATE, lang: "en" })), "notConfigured");
  });
});

describe("platform network request", () => {
  const dir = tmp("pc-network-");
  write(dir, "instance.yaml", exampleText);

  it("prints the text of an environment, in Czech too, or writes it to a file", () => {
    const r = cli(["network", "request", "--config-dir", dir, "--env", "prod"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Network request: connect prod \(Internet \+ internal systems\) to the hub\n/);
    const cs = cli(["network", "request", "--config-dir", dir, "--env", "prod", "--lang", "cs"]);
    assert.equal(cs.code, 0, cs.stderr);
    assert.match(cs.stdout, /^Žádost o síť: připojit prod/);
    const out = join(dir, "out.txt");
    const w = cli(["network", "request", "--config-dir", dir, "--env", "nonprod", "--output", out]);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /^OK {2}network-request-contoso-nonprod-hyb written to /);
    assert.match(readFileSync(out, "utf8"), /^Network request: connect nonprod/);
  });

  it("exit 1 for an environment without the mode, 2 for usage", () => {
    const missing = cli(["network", "request", "--config-dir", dir, "--env", "qa"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /"qa" is not an environment of this instance/);
    assert.equal(cli(["network", "request", "--config-dir", dir]).code, 2);
    assert.equal(cli(["network", "request", "--config-dir", dir, "--env", "prod", "--lang", "de"]).code, 2);
    assert.match(cli(["network", "request", "--config-dir", dir, "--env", "prod", "--mode", "internalOnly"]).stderr, /internalOnly is not built yet/);
    assert.equal(cli(["network", "nope"]).code, 2);
    assert.equal(cli(["network", "request", "--config-dir", join(dir, "missing"), "--env", "prod"]).code, 1);
    const help = cli(["network", "help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /platform network <command>/);
    assert.match(cli(["help"]).stdout, /platform network request --env <name>/);
  });
});
