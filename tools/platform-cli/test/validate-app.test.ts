import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, git, REPO_ROOT, tmp } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import { compareWithBase, otherAppsFromTexts, validateApp, validateAppText } from "../src/validate-app.js";
import type { AppData, AppValidateResult } from "../src/validate-app.js";

const EXAMPLE = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const FIX = join(FIXTURES, "app-definitions");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Writes an app definition to <tmp>/apps/<dir>/app.yaml (the directory name is checked). */
function appFile(content: string | Doc, dir?: string): string {
  const text = typeof content === "string" ? content : stringify(content);
  const slug = dir ?? ((parse(text) as Doc | null)?.slug as string | undefined) ?? "demo-app";
  const d = join(tmp("pc-app-def-"), "apps", slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "app.yaml"), text);
  return join(d, "app.yaml");
}

function example(mutate?: (d: Doc) => void): Doc {
  const d = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  mutate?.(d);
  return d;
}

const msgs = (r: AppValidateResult): string => [...r.problems.map((p) => `${p.path}: ${p.message}`), ...r.checks.map((c) => `${c.path}: ${c.message}`)].join("\n");

describe("platform validate app: schema", () => {
  it("accepts the Contoso example with the example instance", () => {
    const r = validateApp(EXAMPLE, { instance: INSTANCE });
    assert.equal(msgs(r), "");
    assert.equal(r.ok, true);
  });

  it("reports the schema violations of the negative fixture with line numbers", () => {
    const r = validateApp(appFile(readFileSync(join(FIX, "schema-errors.yaml"), "utf8")));
    assert.equal(r.ok, false);
    const text = msgs(r);
    for (const expected of [
      /^bogus: unknown property "bogus"/m,
      /^title: /m,
      /^owner\.principalType: must be "User"/m,
      /^owner\.email: /m,
      /^deputy\.objectId: has an invalid format/m,
      /^repository\.provider: must be one of: "azureDevOps"/m,
      /^repository\.defaultBranch: has an invalid format/m,
      /^repository\.template: must be one of: "node-ts", "python-fastapi", "dotnet", "byo"/m,
      /^authentication\.mode: must be one of: "required", "anonymous"/m,
      /^authentication\.roles\[0\]\.value: has an invalid format/m,
      /^data\.database\.engine: must be one of: "postgres", "azureSql"/m,
      /^data\.database\.size: must be one of: "S", "M", "L"/m,
      /^environments\.nonprod\.networkMode: must be one of: "externalOnly", "externalHybrid"/m,
      // Custom domains bound to the Container App are dropped (ADR-0010, amended 2026-11-12): the
      // key is unknown; a custom domain is environments.<env>.frontDoor.hostName.
      /^environments\.nonprod\.customDomains: unknown property "customDomains"/m,
      /^environments\.nonprod\.budget\.monthlyAmount: must be >= 1/m,
    ]) assert.match(text, expected);
    assert.ok(r.problems.every((p) => typeof p.line === "number"));
    assert.equal(r.checks.length, 0, "semantic checks only run on a schema-valid document");
  });

  it("requires owner, deputy, repository, authentication and at least one environment", () => {
    const r = validateApp(appFile({ schemaVersion: "1.0-draft", slug: "demo-app", title: "Demo", environments: {} }));
    const text = msgs(r);
    for (const k of ["owner", "deputy", "repository", "authentication"]) assert.match(text, new RegExp(`missing required property "${k}"`));
    assert.match(text, /^environments: /m);
  });
});

describe("platform validate app: app-internal checks", () => {
  it("needs slug == directory name and no reserved words", () => {
    const r = validateApp(appFile(example(), "other-dir"));
    assert.match(msgs(r), /slug "hotel-inventory" must equal the directory name apps\/other-dir\//);
    const reserved = validateApp(appFile(example((d) => (d.slug = "microsoft-tools"))));
    assert.match(msgs(reserved), /uses a reserved word \("microsoft"\)/);
  });

  it("keeps title and description safe for the app repo templates (repo render)", () => {
    const r = validateApp(appFile(example((d) => ((d.title = "Stock | Levels"), (d.description = "Line one\nline two")))));
    assert.match(msgs(r), /^title: title must not contain line breaks, "\{\{", backticks, \|, < or >, nor invisible formatting characters such as bidi controls or zero-width spaces \(it is written into the app repo's AGENTS\.md and README\)\./m);
    assert.match(msgs(r), /^description: description must not contain line breaks/m);
    for (const bad of ["a `b`", "<b>", "{{X}}", "Stock\u202Egnp.exe", "Stock\u200BLevels", "Stock\u2066x\u2069", "\uFEFFStock"]) {
      assert.equal(validateApp(appFile(example((d) => (d.title = bad)))).ok, false, JSON.stringify(bad));
    }
    assert.equal(validateApp(appFile(example((d) => (d.description = "Lager\u00ADbestand")))).ok, false, "soft hyphen is a format character");
    assert.equal(validateApp(appFile(example((d) => (d.title = "Stock & levels: 2026 (beta)")))).ok, true);
    assert.equal(validateApp(appFile(example((d) => delete d.repository.template))).ok, true, "repository.template is optional (absent = unmanaged)");
    assert.equal(validateApp(appFile(example((d) => (d.title = "Čerpadla – sklad 2026 (ß, 日本)")))).ok, true, "letters of any script are fine");
  });

  it("reports the semantic errors of the negative fixture against the example instance", () => {
    const r = validateApp(appFile(readFileSync(join(FIX, "semantic-errors.yaml"), "utf8")), { instance: INSTANCE });
    assert.equal(r.problems.length, 0, msgs(r));
    const text = msgs(r);
    for (const expected of [
      /deputy\.objectId: owner and deputy must be different people/,
      /deputy\.email: owner and deputy must have different email addresses/,
      /developers\[1\]: developer .* is listed more than once/,
      /authentication\.roles\[1\]: role "Reader" is defined more than once/,
      /authentication\.assignments\[0\]\.role: assignment uses role "Owner", which is not in authentication\.roles/,
      /environments\.prod\.databaseSize: databaseSize needs data\.database/,
      /environments\.qa: "qa" is not an environment of this instance \(nonprod, prod\)/,
      /environments\.prod: prod receives builds from nonprod, so the app must also run in nonprod/,
      /authentication\.mode: anonymous apps are not allowed in this instance/,
      /repository\.project: project "Marketing" is not allowed for app repos \(Apps, Finance, HR\)/,
    ]) assert.match(text, expected);
    assert.ok(r.checks.every((c) => typeof c.line === "number"), "every finding points at a line");
  });

  it("lets groups and individual people hold roles: a person may hold several, but not the same one twice", () => {
    const jana = { principalType: "User", objectId: "00000000-0000-0000-0000-00000000e106", displayName: "Jana Dvořáková" };
    const mixed = validateApp(
      appFile(example((d) => d.authentication.assignments.push({ role: "Reader", ...jana }, { role: "Editor", ...jana }))),
      { instance: INSTANCE },
    );
    assert.equal(msgs(mixed), "");
    assert.equal(mixed.ok, true);
    const twice = validateApp(
      appFile(example((d) => d.authentication.assignments.push({ role: "Reader", ...jana }, { role: "Reader", ...jana, objectId: jana.objectId.toUpperCase() }))),
      { instance: INSTANCE },
    );
    assert.match(msgs(twice), /authentication\.assignments\[3\]: 00000000-0000-0000-0000-00000000E106 is assigned role "Reader" twice\./);
    // Only users and groups, not anything else Entra knows.
    const odd = validateApp(appFile(example((d) => d.authentication.assignments.push({ role: "Reader", ...jana, principalType: "ServicePrincipal" }))), { instance: INSTANCE });
    assert.match(msgs(odd), /^authentication\.assignments\[2\]\.principalType: /m);
  });

  it("checks assignments against the instance default roles when the app defines none", () => {
    const r = validateApp(
      appFile(example((d) => {
        delete d.authentication.roles;
        d.authentication.assignments[0].role = "Auditor";
      })),
      { instance: INSTANCE },
    );
    assert.match(msgs(r), /role "Auditor", which is not a default app role of this instance \(Reader, Editor, Admin\)/);
  });
});

describe("platform validate app: instance checks", () => {
  it("network mode must be enabled, a hybrid app needs an active egress baseline", () => {
    const noHybrid = instanceFile((d) => {
      delete (d.environments[0] as Doc).networkModes.externalHybrid;
    });
    const r1 = validateApp(appFile(example((d) => (d.environments.nonprod.networkMode = "externalHybrid"))), { instance: noHybrid });
    assert.match(msgs(r1), /network mode externalHybrid is not enabled in environment nonprod/);
    const requested = instanceFile((d) => {
      (d.environments[1] as Doc).networkModes.externalHybrid.egressBaseline.status = "requested";
    });
    const r2 = validateApp(appFile(example()), { instance: requested });
    assert.match(msgs(r2), /externalHybrid in prod needs the egress baseline firewall rules to be active \(status: requested\)/);
  });

  it("checks data services and sizes against instance.data", () => {
    const off = instanceFile((d) => ((d.data as Doc).postgres.enabled = false));
    assert.match(msgs(validateApp(appFile(example()), { instance: off })), /data\.database\.engine: postgres is not offered in this instance/);
    const sql = validateApp(appFile(example((d) => (d.data.database = { engine: "azureSql", size: "S" }))), { instance: INSTANCE });
    assert.equal(sql.ok, true, msgs(sql));
    const onlyS = instanceFile((d) => ((d.data as Doc).azureSql.sizes = { S: { sku: "S0" } }));
    const big = validateApp(appFile(example((d) => (d.data.database = { engine: "azureSql", size: "S" }))), { instance: onlyS });
    assert.match(msgs(big), /environments\.prod\.databaseSize: database size M is not offered for azureSql \(S\)/);
    const noVault = instanceFile((d) => ((d.data as Doc).storage.vaultedBackup.offeredInProd = false));
    assert.match(msgs(validateApp(appFile(example((d) => (d.data.storage.vaultedBackup = true))), { instance: noVault })), /vaulted backup is not offered/);
  });

  it("applies budgets.mode", () => {
    const offInst = instanceFile((d) => ((d.budgets as Doc).mode = "off"));
    assert.match(msgs(validateApp(appFile(example()), { instance: offInst })), /environments\.nonprod\.budget: budgets are switched off/);
    const required = instanceFile((d) => ((d.budgets as Doc).mode = "required"));
    assert.match(msgs(validateApp(appFile(example()), { instance: required })), /environments\.prod\.budget: this instance requires a budget/);
    const noBudget = validateApp(appFile(example((d) => delete d.environments.prod.budget)), { instance: required });
    assert.equal(noBudget.ok, true, `absent = instance default: ${msgs(noBudget)}`);
  });

  it("allows anonymous only with enforcement ownerChoice", () => {
    const choice = instanceFile((d) => ((d.authentication as Doc).enforcement = "ownerChoice"));
    const r = validateApp(appFile(example((d) => (d.authentication.mode = "anonymous"))), { instance: choice });
    assert.equal(r.ok, true, msgs(r));
  });
});

describe("platform validate app: every app has its own repository", () => {
  /** A platform-config with the example instance and these apps (slug -> repository name). */
  function config(apps: Record<string, { project?: string; name: string }>): { root: string; file: (slug: string) => string; instance: string } {
    const root = join(tmp("pc-app-config-"), "platform-config");
    mkdirSync(join(root, "apps"), { recursive: true });
    copyFileSync(INSTANCE, join(root, "instance.yaml"));
    for (const [slug, repo] of Object.entries(apps)) {
      mkdirSync(join(root, "apps", slug));
      const d = example((x) => {
        x.slug = slug;
        x.repository.name = repo.name;
        if (repo.project) x.repository.project = repo.project;
      });
      writeFileSync(join(root, "apps", slug, "app.yaml"), stringify(d));
    }
    return { root, file: (slug) => join(root, "apps", slug, "app.yaml"), instance: join(root, "instance.yaml") };
  }

  it("fails both apps that share a repository (case-insensitive) and names both slugs", () => {
    const c = config({ "stock-a": { name: "stock" }, "stock-b": { name: "STOCK" }, other: { name: "other" } });
    const a = validateApp(c.file("stock-a"), { instance: c.instance });
    assert.equal(a.ok, false);
    assert.match(msgs(a), /^repository\.name: apps "stock-a" and "stock-b" both use the repository Apps\/stock; each app needs its own repository\.$/m);
    assert.ok(a.checks.find((x) => x.path === "repository.name")?.line);
    assert.match(msgs(validateApp(c.file("stock-b"), { instance: c.instance })), /apps "stock-b" and "stock-a" both use the repository Apps\/STOCK/);
    assert.equal(validateApp(c.file("other"), { instance: c.instance }).ok, true);
    const gen = cli(["generate", "--config-dir", c.root]);
    assert.equal(gen.code, 1);
    assert.match(gen.stderr, /apps\/stock-a\/app\.yaml: .*apps "stock-a" and "stock-b" both use the repository/);
  });

  it("allows the same name in another project, and checks only within one platform-config", () => {
    const c = config({ "stock-a": { name: "stock" }, "stock-b": { name: "stock", project: "Finance" } });
    assert.equal(validateApp(c.file("stock-a"), { instance: c.instance }).ok, true);
    const elsewhere = config({ "stock-a": { name: "stock" }, "stock-b": { name: "stock" } });
    assert.equal(validateApp(elsewhere.file("stock-a"), { instance: INSTANCE }).ok, true, "--instance of another config: no sibling check");
    assert.equal(validateApp(elsewhere.file("stock-a")).ok, true, "without --instance: no sibling check");
  });
});

describe("platform validate app: custom domain through Front Door (ADR-0010, amended 2026-11-01)", () => {
  /** The example instance with sign-in left to owners (anonymous apps allowed). */
  const ownerChoice = (mutate?: (d: Doc) => void): string =>
    instanceFile((d) => {
      (d as Doc).authentication.enforcement = "ownerChoice";
      mutate?.(d as Doc);
    });
  /** The example as an anonymous app with a custom domain in nonprod. */
  const anonymous = (host = "hotel-inventory-test.contoso.com", mutate?: (d: Doc) => void): Doc =>
    example((d) => {
      d.authentication = { mode: "anonymous" };
      d.environments.nonprod.frontDoor = { hostName: host };
      mutate?.(d);
    });

  it("accepts a host below a zone allowed in the environment", () => {
    const r = validateApp(appFile(anonymous()), { instance: ownerChoice() });
    assert.equal(msgs(r), "");
    const prod = validateApp(appFile(anonymous("hotel-inventory.contoso.eu", (d) => {
      delete d.environments.nonprod.frontDoor;
      d.environments.prod.frontDoor = { hostName: "hotel-inventory.contoso.eu" };
    })), { instance: ownerChoice() });
    assert.equal(msgs(prod), "", "contoso.eu (manual zone) is allowed in prod");
  });

  it("schema: lower-case host with at least three labels, nothing else", () => {
    for (const bad of ["Hotel.contoso.com", "contoso.com", "https://a.contoso.com", "a.contoso.com.", "*.contoso.com", "a_b.contoso.com"]) {
      const r = validateApp(appFile(anonymous(bad)), { instance: ownerChoice() });
      assert.ok(r.problems.some((p) => p.path === "environments.nonprod.frontDoor.hostName"), `${bad}: ${msgs(r)}`);
    }
    const extra = validateApp(appFile(anonymous(undefined, (d) => (d.environments.nonprod.frontDoor.waf = true))), { instance: ownerChoice() });
    assert.match(msgs(extra), /^environments\.nonprod\.frontDoor\.waf: unknown property "waf"/m);
  });

  it("checks the zone, its environments, the apex and reserved subdomains", () => {
    const inst = ownerChoice();
    const at = (host: string): string => msgs(validateApp(appFile(anonymous(host)), { instance: inst }));
    assert.match(at("app.fabrikam.com"), /"app\.fabrikam\.com" is not inside a DNS zone of this instance \(dns\.zones: contoso\.com, contoso\.eu\)/);
    assert.match(at("app.contoso.eu"), /the DNS zone contoso\.eu is not allowed in environment nonprod \(allowedEnvironments: prod\)/);
    assert.match(at("www.contoso.com"), /"www" is a reserved subdomain of this instance \(dns\.reservedSubdomains\)/);
    const apex = ownerChoice((d) => d.dns.zones.push({ name: "apps.contoso.com", provider: "manual", allowedEnvironments: ["nonprod"] }));
    assert.match(msgs(validateApp(appFile(anonymous("apps.contoso.com")), { instance: apex })), /"apps\.contoso\.com" is a DNS zone itself; use a host below it/);
    assert.equal(msgs(validateApp(appFile(anonymous("stock.apps.contoso.com")), { instance: apex })), "", "the longest zone wins");
  });

  it("needs a managed Front Door profile in the environment; apps with sign-in may have one too", () => {
    const external = ownerChoice((d) => (d.frontDoor = { mode: "external", external: { profiles: [] } }));
    assert.match(msgs(validateApp(appFile(anonymous()), { instance: external })), /^environments\.nonprod\.frontDoor: name the external Front Door profile that serves the app \(profile: none defined/m);
    const managedWithProfile = validateApp(appFile(anonymous(undefined, (d) => Object.assign(d.environments.nonprod.frontDoor, { profile: "afd-network", frontDoorId: "00000000-0000-0000-0000-0000000000f2" }))), { instance: ownerChoice() });
    assert.match(msgs(managedWithProfile), /^environments\.nonprod\.frontDoor\.profile: profile is for external Front Door mode only/m);
    assert.match(msgs(managedWithProfile), /^environments\.nonprod\.frontDoor\.frontDoorId: frontDoorId is for external Front Door mode only/m);
    const noProfile = ownerChoice((d) => (d.frontDoor.managed.profiles = d.frontDoor.managed.profiles.filter((p: Doc) => p.environment !== "nonprod")));
    assert.match(msgs(validateApp(appFile(anonymous()), { instance: noProfile })), /environment nonprod has no managed Front Door profile \(instance\.yaml frontDoor\.managed\.profiles\)/);
    // Sign-in on a custom host (ADR-0010, amended 2026-11-02): the Entra registration lists its callback.
    const signIn = validateApp(appFile(example((d) => (d.environments.nonprod.frontDoor = { hostName: "hotel-inventory-test.contoso.com" }))), { instance: INSTANCE });
    assert.equal(msgs(signIn), "");
    assert.equal(signIn.ok, true);
  });

  it("each host belongs to one app and one environment (lower-case), also against the other apps of the platform-config", () => {
    const twice = validateApp(appFile(anonymous(undefined, (d) => (d.environments.prod.frontDoor = { hostName: "hotel-inventory-test.contoso.com" }))), { instance: ownerChoice() });
    assert.match(msgs(twice), /^environments\.prod\.frontDoor\.hostName: host "hotel-inventory-test\.contoso\.com" is already the custom domain of environment nonprod; each environment needs its own host\./m);

    const root = join(tmp("pc-fd-config-"), "platform-config");
    mkdirSync(join(root, "apps"), { recursive: true });
    copyFileSync(ownerChoice(), join(root, "instance.yaml"));
    for (const [slug, host] of [["stock-a", "stock-test.contoso.com"], ["stock-b", "STOCK-test.contoso.com".toLowerCase()], ["other", "other-test.contoso.com"]] as const) {
      mkdirSync(join(root, "apps", slug));
      writeFileSync(join(root, "apps", slug, "app.yaml"), stringify(anonymous(host, (d) => ((d.slug = slug), (d.repository.name = slug)))));
    }
    const a = validateApp(join(root, "apps", "stock-a", "app.yaml"), { instance: join(root, "instance.yaml") });
    assert.match(msgs(a), /^environments\.nonprod\.frontDoor\.hostName: host "stock-test\.contoso\.com" is already the custom domain of app "stock-b"; each custom domain belongs to one app and environment\.$/m);
    assert.equal(validateApp(join(root, "apps", "other", "app.yaml"), { instance: join(root, "instance.yaml") }).ok, true);
  });

  it("no two apps of one environment get the same Front Door custom-domain name (ADR-0052, front-door-domain-name)", () => {
    const root = join(tmp("pc-fd-cd-"), "platform-config");
    mkdirSync(join(root, "apps"), { recursive: true });
    copyFileSync(ownerChoice(), join(root, "instance.yaml"));
    const apps: [string, string, string][] = [
      ["orders", "nonprod", "shop-orders-test.contoso.com"],
      ["orders-b", "nonprod", "shop.orders-test.contoso.com"],
      ["orders-c", "prod", "shop-orders.test.contoso.com"],
    ];
    for (const [slug, env, host] of apps) {
      mkdirSync(join(root, "apps", slug));
      writeFileSync(join(root, "apps", slug, "app.yaml"), stringify(anonymous(host, (d) => {
        d.slug = slug;
        d.repository.name = slug;
        if (env !== "nonprod") {
          delete d.environments.nonprod.frontDoor;
          d.environments[env].frontDoor = { hostName: host };
        }
      })));
    }
    const at = (slug: string) => validateApp(join(root, "apps", slug, "app.yaml"), { instance: join(root, "instance.yaml") });
    const b = at("orders-b");
    assert.equal(b.ok, false);
    assert.match(msgs(b), /^environments\.nonprod\.frontDoor\.hostName: host "shop\.orders-test\.contoso\.com" gets the Front Door custom-domain name cd-shop-orders-test-contoso-com, which app "orders" already uses for "shop-orders-test\.contoso\.com" in environment nonprod; choose a host that differs in more than dots and hyphens \(check front-door-domain-name\)\.$/m);
    assert.equal(b.checks.find((c) => c.checkId === "front-door-domain-name")?.path, "environments.nonprod.frontDoor.hostName");
    assert.match(msgs(at("orders")), /app "orders-b" already uses for "shop\.orders-test\.contoso\.com"/, "both apps are told");
    // Another environment has its own Front Door profile: the same name there is no clash.
    assert.equal(msgs(at("orders-c")), "");
    // The same host (not only the same name) keeps the existing message without a checkId.
    const same = validateAppText(stringify(anonymous("orders-test.contoso.com", (d) => ((d.slug = "x-app"), (d.repository.name = "x-app")))), {
      file: "apps/x-app/app.yaml",
      others: otherAppsFromTexts([{ slug: "orders", text: stringify(anonymous("orders-test.contoso.com")) }]),
    });
    assert.match(msgs(same), /is already the custom domain of app "orders"/);
    assert.ok(same.checks.every((c) => c.checkId === undefined));
  });

  it("a host change to a host with the same custom-domain name fails; no app may use the portal's own address (ADR-0052)", () => {
    const cmp = compareWithBase(anonymous("orders-test.contoso.com") as AppData, anonymous("orders.test.contoso.com") as AppData);
    assert.match(cmp.checks.map((f) => f.message).join("\n"), /custom domain orders-test\.contoso\.com -> orders\.test\.contoso\.com in nonprod: both get the Front Door custom-domain name cd-orders-test-contoso-com/);
    assert.equal(cmp.checks[0]?.checkId, "front-door-domain-name");
    assert.deepEqual(cmp.destructive, []);
    const portal = ownerChoice((d) => (d.portal = { ...(d.portal ?? {}), apiBaseUrl: "https://apps.contoso.com:8443" }));
    assert.match(msgs(validateApp(appFile(anonymous("apps.contoso.com")), { instance: portal })), /"apps\.contoso\.com" is the portal's own address \(instance\.yaml portal\.apiBaseUrl\); no app may use it\./);
    assert.equal(msgs(validateApp(appFile(anonymous("apps-test.contoso.com")), { instance: portal })), "");
  });

  it("reports a removed or changed host as destructive: provisioning removes it, after an overlap on a change (amended 2026-11-11)", () => {
    const base = anonymous();
    const removed = compareWithBase(base as AppData, anonymous(undefined, (d) => delete d.environments.nonprod.frontDoor) as AppData);
    assert.match(removed.destructive.map((f) => f.message).join("\n"), /the custom domain hotel-inventory-test\.contoso\.com is removed in nonprod: provisioning opens the app's ingress again, then deletes its Front Door route, custom domain and the DNS records it wrote \(fd-hotel-inventory-nonprod\)/);
    const moved = compareWithBase(base as AppData, anonymous("stock-test.contoso.com") as AppData);
    assert.match(moved.destructive.map((f) => f.message).join("\n"), /custom domain hotel-inventory-test\.contoso\.com -> stock-test\.contoso\.com in nonprod: hotel-inventory-test\.contoso\.com keeps working until Front Door serves stock-test\.contoso\.com/);
    assert.deepEqual(compareWithBase(base as AppData, anonymous() as AppData).destructive, []);
    // External mode: the team that runs the profile removes or moves its route.
    const ext = anonymous(undefined, (d) => Object.assign(d.environments.nonprod.frontDoor, { profile: "afd-network" }));
    const extRemoved = compareWithBase(ext as AppData, anonymous(undefined, (d) => delete d.environments.nonprod.frontDoor) as AppData);
    assert.match(extRemoved.destructive.map((f) => f.message).join("\n"), /the team that runs the external Front Door profile removes its route and domain/);
  });

  it("external mode (US08.09): a profile of frontDoor.external allowed in the environment, the Front Door ID from exactly one place", () => {
    const inst = ownerChoice((d) => {
      d.frontDoor = {
        mode: "external",
        external: {
          profiles: [
            { name: "afd-network", frontDoorId: "00000000-0000-0000-0000-0000000000f1" },
            { name: "afd-test", allowedEnvironments: ["nonprod"] },
          ],
        },
      };
    });
    const at = (fd: Doc, env = "nonprod"): string =>
      msgs(validateApp(appFile(anonymous(undefined, (d) => {
        delete d.environments.nonprod.frontDoor;
        d.environments[env].frontDoor = fd;
      })), { instance: inst }));
    assert.equal(at({ hostName: "hotel-inventory-test.contoso.com", profile: "afd-network" }), "", "the profile defines the ID");
    assert.equal(at({ hostName: "hotel-inventory-test.contoso.com", profile: "afd-test", frontDoorId: "00000000-0000-0000-0000-0000000000f2" }), "", "the app gives the ID");
    assert.match(at({ hostName: "hotel-inventory-test.contoso.com", profile: "afd-test" }), /instance\.yaml defines no Front Door ID for the external profile afd-test: give the expected X-Azure-FDID here/);
    assert.match(at({ hostName: "hotel-inventory-test.contoso.com", profile: "afd-network", frontDoorId: "00000000-0000-0000-0000-0000000000f2" }), /defines its Front Door ID in instance\.yaml; leave frontDoorId out here/);
    assert.match(at({ hostName: "hotel-inventory-test.contoso.com", profile: "afd-other" }), /"afd-other" is not an external Front Door profile of this instance \(frontDoor\.external\.profiles: afd-network, afd-test\)/);
    assert.match(at({ hostName: "hotel-inventory.contoso.eu", profile: "afd-test", frontDoorId: "00000000-0000-0000-0000-0000000000f2" }, "prod"), /the external Front Door profile afd-test is not allowed in environment prod/);
    assert.match(at({ hostName: "hotel-inventory-test.contoso.com", profile: "afd-network", frontDoorId: "not-a-guid" }), /frontDoorId/);
  });
});

describe("platform validate app --base (immutability)", () => {
  function repoWith(base: string): { file: string; root: string } {
    const root = tmp("pc-app-git-");
    git(root, "init", "-q", "-b", "main");
    const dir = join(root, "apps", "demo-app");
    mkdirSync(dir, { recursive: true });
    copyFileSync(base, join(dir, "app.yaml"));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    return { file: join(dir, "app.yaml"), root };
  }
  const v1 = (): Doc => parse(readFileSync(join(FIX, "base-v1.yaml"), "utf8")) as Doc;

  it("accepts an unchanged file and reports a new app", () => {
    const { file } = repoWith(join(FIX, "base-v1.yaml"));
    const r = validateApp(file, { base: "main" });
    assert.equal(r.ok, true, msgs(r));
    assert.deepEqual(r.base, { ref: "main", found: true });
    const fresh = validateApp(appFile(example()), {});
    assert.equal(fresh.base, undefined);
  });

  it("fails on a lowered generation, a changed slug or database engine", () => {
    const { file } = repoWith(join(FIX, "base-v1.yaml"));
    const d = v1();
    d.generation = 1;
    d.data.database.engine = "azureSql";
    writeFileSync(file, stringify(d));
    const r = validateApp(file, { base: "main" });
    assert.equal(r.ok, false);
    assert.match(msgs(r), /generation: generation went down from 2 to 1/);
    assert.match(msgs(r), /data\.database\.engine: database engine changed from postgres to azureSql/);
    d.generation = 2;
    d.data.database.engine = "postgres";
    d.slug = "demo-app2";
    writeFileSync(file, stringify(d));
    assert.match(msgs(validateApp(file, { base: "main" })), /slug changed from "demo-app" to "demo-app2"/);
  });

  it("reports destructive changes without failing", () => {
    const { file } = repoWith(join(FIX, "base-v1.yaml"));
    const d = v1();
    d.generation = 3;
    delete d.environments.nonprod;
    delete d.data;
    writeFileSync(file, stringify(d));
    const r = validateApp(file, { base: "main" });
    assert.equal(r.ok, true, msgs(r));
    const text = r.destructive.map((x) => `${x.path}: ${x.message}`).join("\n");
    assert.match(text, /generation 2 -> 3: the app's registry and app vault are re-created/);
    assert.match(text, /removed from environment nonprod/);
    assert.match(text, /the postgres database is removed/);
    assert.match(text, /the storage account is removed/);
  });

  it("reports a move between externalOnly and externalHybrid as destructive, not failed (ADR-0060)", () => {
    const { file } = repoWith(join(FIX, "base-v1.yaml"));
    const d = v1();
    d.environments.prod.networkMode = "externalHybrid";
    writeFileSync(file, stringify(d));
    const r = validateApp(file, { base: "main" });
    assert.equal(r.ok, true, msgs(r));
    assert.deepEqual(r.checks, [], "the move is no error");
    const moved = r.destructive.filter((f) => f.path === "environments.prod.networkMode");
    assert.equal(moved.length, 1, "nonprod, unchanged, is not reported");
    assert.ok(moved[0]!.line !== undefined && moved[0]!.line > 0, "with the line of the changed mode");
    assert.equal(moved[0]!.checkId, undefined, "a destructive note, not the check's refusal");
    assert.match(moved[0]!.message, /^network mode externalOnly -> externalHybrid in prod: provisioning moves the app there with a short outage: its Container App is deleted and created again in the externalHybrid Container Apps environment with the same image \(ADR-0060\)\.$/);
    // The CLI passes (exit 0) and prints it as DESTRUCTIVE.
    const out = cli(["validate", "app", file, "--base", "main"]);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^DESTRUCTIVE {2}line \d+: environments\.prod\.networkMode: network mode externalOnly -> externalHybrid in prod/m);
  });

  it("with the instance, names case A or B and when the move runs (ADR-0060)", () => {
    const base = v1() as AppData;
    const env = (name: string, kind: string, network?: string) => ({ name, kind, networkModes: { externalOnly: network ? { network } : {}, externalHybrid: { egressBaseline: { status: "active" } } } });
    const inst = { environments: [env("nonprod", "nonprod", "vnet"), env("prod", "prod")] };
    const into = v1();
    into.environments.nonprod.networkMode = "externalHybrid";
    into.environments.prod.networkMode = "externalHybrid";
    const cmp = compareWithBase(base, into as AppData, undefined, inst);
    assert.deepEqual(cmp.checks, []);
    const line = (path: string) => cmp.destructive.find((f) => f.path === path)?.message ?? "";
    // Case B (External only in a VNet), kind nonprod: in the merge's run, the endpoints move spoke.
    assert.match(line("environments.nonprod.networkMode"), /^network mode externalOnly -> externalHybrid in nonprod \(case B\): provisioning moves the app there with a short outage, in the merge's provisioning run: .*; its private endpoints are created again in the hybrid spoke \(ADR-0060\)\.$/);
    // Case A (the managed network), kind prod: in the maintenance window, a new sign-in secret.
    assert.match(line("environments.prod.networkMode"), /^network mode externalOnly -> externalHybrid in prod \(case A\): provisioning moves the app there with a short outage, inside the maintenance window: .*get private endpoints and lose public access, and a sign-in secret is issued again in the private environment vault \(ADR-0060\)\.$/);
    // And back out of hybrid.
    const back = compareWithBase(into as AppData, base, undefined, inst);
    assert.deepEqual(back.checks, []);
    assert.match(back.destructive.map((f) => f.message).join("\n"), /externalHybrid -> externalOnly in prod \(case A\): .*get public access \(Entra-only\) back and lose their private endpoints, and a sign-in secret is issued again in the public environment vault/);
    assert.match(back.destructive.map((f) => f.message).join("\n"), /externalHybrid -> externalOnly in nonprod \(case B\): .*created again in the External-only spoke/);
  });

  it("refuses the network mode changes the platform can't make (check network-mode-change, ADR-0060)", () => {
    const refused = (was: Doc, now: Doc) => {
      const cmp = compareWithBase(was as AppData, now as AppData);
      assert.equal(cmp.destructive.filter((f) => f.path.endsWith(".networkMode")).length, 0, "refused, not destructive");
      return cmp.checks.map((c) => [c.checkId, c.path, c.message]);
    };
    // Internal only, to or from (deferred; the schema doesn't offer it yet, compareWithBase refuses it anyway).
    const internal = v1();
    internal.environments.prod.networkMode = "internalOnly";
    const [to] = refused(v1(), internal);
    assert.deepEqual(to!.slice(0, 2), ["network-mode-change", "environments.prod.networkMode"]);
    assert.match(to![2]!, /^network mode externalOnly -> internalOnly in prod: Internal only isn't available yet, so the platform can't move an app to or from it \(ADR-0060\)\. Keep externalOnly \(check network-mode-change\)\.$/);
    assert.match(refused(internal, v1())[0]![2]!, /^network mode internalOnly -> externalOnly in prod: Internal only isn't available yet/);
    // Any other pair.
    const other = v1();
    other.environments.prod.networkMode = "somethingElse";
    assert.match(refused(v1(), other)[0]![2]!, /the platform moves an app only between externalOnly and externalHybrid \(ADR-0060\)/);
  });

  it("moves an app in any capacity cell, keeping or changing the cell with the mode (ADR-0060 amendment 2026-11-16)", () => {
    const moved = (was: Doc, now: Doc) => {
      const cmp = compareWithBase(was as AppData, now as AppData);
      assert.deepEqual(cmp.checks, [], "no refusal");
      return cmp.destructive.filter((f) => f.path === "environments.prod.networkMode").map((f) => f.message);
    };
    // The same number in the target mode: the line names the cell the app lands in.
    const inCell = v1();
    inCell.environments.prod.cell = "02";
    const keep = v1();
    keep.environments.prod = { networkMode: "externalHybrid", cell: "02" };
    assert.match(moved(inCell, keep)[0]!, /^network mode externalOnly -> externalHybrid in prod \(capacity cell 02 -> 02\): provisioning moves the app there with a short outage: its Container App is deleted and created again in the externalHybrid Container Apps environment of cell 02 with the same image \(ADR-0060\)\.$/);
    // Another cell of the target mode (cells are per mode): from 02 to 01, and from 01 to 03.
    const back = v1();
    back.environments.prod.networkMode = "externalHybrid";
    assert.match(moved(inCell, back)[0]!, /\(capacity cell 02 -> 01\).* Container Apps environment of cell 01 /);
    const other = v1();
    other.environments.prod = { networkMode: "externalHybrid", cell: "03" };
    assert.match(moved(v1(), other)[0]!, /\(capacity cell 01 -> 03\)/);
    // Cell 01 on both sides: the line is as before cells (no cell named).
    const plain = v1();
    plain.environments.prod.networkMode = "externalHybrid";
    assert.doesNotMatch(moved(v1(), plain)[0]!, /cell/);
  });

  it("refuses a capacity cell change without a network mode change (check cell-change, ADR-0053)", () => {
    const inCell = v1();
    inCell.environments.prod.cell = "02";
    const cmp = compareWithBase(v1() as AppData, inCell as AppData);
    assert.deepEqual(cmp.checks.map((c) => [c.checkId, c.path]), [["cell-change", "environments.prod.cell"]]);
    assert.match(cmp.checks[0]!.message, /^capacity cell 01 -> 02 in prod: the app runs in externalOnly there, and the platform doesn't move an app between the cells of one network mode \(ADR-0053\); a cell changes only with a network mode change \(ADR-0060\)\. Keep cell 01 \(check cell-change\)\.$/);
    assert.deepEqual(cmp.destructive, []);
    // The key removed (back to 01) is a change too; it points at the environment.
    const out = compareWithBase(inCell as AppData, v1() as AppData);
    assert.deepEqual(out.checks.map((c) => [c.checkId, c.path]), [["cell-change", "environments.prod"]]);
    // "01" written out where the base had no key is no change.
    const explicit = v1();
    explicit.environments.prod.cell = "01";
    assert.deepEqual(compareWithBase(v1() as AppData, explicit as AppData).checks, []);
    // A new environment may start in any cell.
    const added = v1();
    added.environments.test = { networkMode: "externalOnly", cell: "02" };
    assert.deepEqual(compareWithBase(v1() as AppData, added as AppData).checks, []);
  });

  it("refuses a cell change of a running app through the CLI (exit 1)", () => {
    const base = v1();
    const root = tmp("pc-app-cell-");
    git(root, "init", "-q", "-b", "main");
    const dir = join(root, "apps", "demo-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.yaml"), stringify(base));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    base.environments.prod.cell = "02";
    writeFileSync(join(dir, "app.yaml"), stringify(base));
    const out = cli(["validate", "app", join(dir, "app.yaml"), "--base", "main"]);
    assert.equal(out.code, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /environments\.prod\.cell: capacity cell 01 -> 02 in prod: .*\(check cell-change\)/);
    // With the mode, the same cell change is the move (exit 0, DESTRUCTIVE).
    base.environments.prod.networkMode = "externalHybrid";
    writeFileSync(join(dir, "app.yaml"), stringify(base));
    const moved = cli(["validate", "app", join(dir, "app.yaml"), "--base", "main"]);
    assert.equal(moved.code, 0, moved.stdout + moved.stderr);
    assert.match(moved.stdout, /^DESTRUCTIVE {2}line \d+: environments\.prod\.networkMode: network mode externalOnly -> externalHybrid in prod \(capacity cell 01 -> 02\)/m);
  });

  it("a new environment in any mode, or one removed, is no change of mode", () => {
    const base = v1() as AppData;
    const added = v1();
    added.environments.test = { networkMode: "externalHybrid" };
    assert.deepEqual(compareWithBase(base, added as AppData).checks, []);
    assert.deepEqual(compareWithBase(base, added as AppData).destructive, []);
    const removed = v1();
    delete removed.environments.prod;
    const cmp = compareWithBase(base, removed as AppData);
    assert.deepEqual(cmp.checks, []);
    assert.match(cmp.destructive.map((f) => f.message).join("\n"), /removed from environment prod/);
    // Changing both environments reports each of them.
    const both = v1();
    both.environments.nonprod.networkMode = "externalHybrid";
    both.environments.prod.networkMode = "externalHybrid";
    const two = compareWithBase(base, both as AppData);
    assert.deepEqual(two.checks, []);
    assert.deepEqual(
      two.destructive.map((c) => c.path),
      ["environments.nonprod.networkMode", "environments.prod.networkMode"],
    );
  });

  it("CLI: text output, exit codes, usage errors", () => {
    const { file } = repoWith(join(FIX, "base-v1.yaml"));
    const d = v1();
    d.generation = 3;
    writeFileSync(file, stringify(d));
    const ok = cli(["validate", "app", file, "--base", "main"]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^OK {2}.* is a valid app definition\.\n/);
    assert.match(ok.stdout, /compared with main/);
    assert.match(ok.stdout, /^DESTRUCTIVE {2}line \d+: generation: generation 2 -> 3/m);
    const json = cli(["validate", "app", file, "--base", "main", "--format", "json"]);
    assert.equal((JSON.parse(json.stdout) as AppValidateResult).destructive.length, 1);

    const bad = cli(["validate", "app", appFile(readFileSync(join(FIX, "semantic-errors.yaml"), "utf8")), "--instance", INSTANCE]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /^FAILED/);

    assert.equal(cli(["validate", "app", file, "--base", "--upload-pack=x"]).code, 2, "option-like ref");
    assert.equal(cli(["validate", "app", file, "--base", "no-such-branch"]).code, 2);
    assert.equal(cli(["validate", "manifest", file, "--instance", INSTANCE]).code, 2);
    const brokenInstance = join(tmp(), "instance.yaml");
    writeFileSync(brokenInstance, "schemaVersion: nope\n");
    assert.equal(cli(["validate", "app", file, "--instance", brokenInstance]).code, 2);
    const outside = appFile(example());
    assert.equal(cli(["validate", "app", outside, "--base", "main"]).code, 2, "not in a git work tree");
  });
});
