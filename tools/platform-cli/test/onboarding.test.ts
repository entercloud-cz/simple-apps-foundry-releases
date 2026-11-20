import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { formatItems, parseItemRows } from "../src/ado/steps.js";
import type { Item } from "../src/ado/steps.js";
import { onboardingInstance } from "../src/instance/onboarding.js";
import { deploymentOutputs } from "../src/instance/inputs.js";
import {
  ACTORS,
  AI_GUIDE_FILES,
  CHECKS,
  CHECK_IDS,
  CONDITIONS,
  GATES,
  PHASES,
  PLAN_BLOCK_END,
  PLAN_BLOCK_START,
  STEPS,
  aiGuideFiles,
  evaluateOnboarding,
  planBlockOf,
  planMarkdownBlock,
  stepById,
} from "../src/onboarding/index.js";
import type { DeploymentRead, OnboardingInstance, OnboardingReport, OnboardingState, Text } from "../src/onboarding/index.js";
import { parseInstanceText } from "../src/provisioning/model.js";
import { FIXTURES, PKG_ROOT, REPO_ROOT, cli, tmp } from "./helpers.js";

// The onboarding plan, instance.sh plan|status's CLI side and the AI guide in platform-config (ADR-0072).
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EXAMPLE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const RUNBOOK = join(REPO_ROOT, "docs", "runbooks", "onboard-instance.md");
const S = join(FIXTURES, "instance");
const read = (f: string): Doc => JSON.parse(readFileSync(f, "utf8")) as Doc;
const inst = (): OnboardingInstance => onboardingInstance(parseInstanceText(readFileSync(EXAMPLE, "utf8")));

/** The step IDs and how each is decided: never renumbered or reused (a new step gets a new ID). */
const PINNED: [string, string][] = [
  ["B01", "instance-valid"],
  ["B02", "confirmed"],
  ["B03", "login"],
  ["B04", "providers"],
  ["B05", "network-approvals"],
  ["B06", "confirmed"],
  ["B07", "confirmed"],
  ["B08", "dns-zones"],
  ["B09", "ado-projects"],
  ["B10", "ado-config"],
  ["B11", "core-tag"],
  ["B12", "bootstrap-host"],
  ["B13", "bootstrap-others"],
  ["B14", "dns-roles"],
  ["B15", "instance-principals"],
  ["B16", "deployment-entra-permissions"],
  ["B17", "confirmed"],
  ["B18", "ado-connections"],
  ["B19", "bootstrap-federation"],
  ["B20", "deployment-roles"],
  ["B21", "ado-pipeline"],
  ["B22", "ado-grants"],
  ["B23", "ado-policies"],
  ["B24", "entra-pull-request"],
  ["B25", "deployment-platform"],
  ["B26", "deployment-audit-alert"],
  ["B27", "deployment-portal"],
  ["B28", "deployment-portal-registration"],
  ["B29", "instance-portal"],
  ["B30", "portal-app"],
  ["B31", "portal-ready"],
  ["B32", "first-app"],
  ["S01", "email-setting"],
];

const PLACEHOLDERS = new Set(["host", "env", "prefix", "portal-url", "portal-client-id", "portal-object-id", "sender", "the identity team's action group"]);

function texts(): [string, Text][] {
  const out: [string, Text][] = [];
  for (const p of PHASES) out.push([`phase ${p.id} title`, p.title], [`phase ${p.id} description`, p.description]);
  for (const [k, t] of Object.entries(ACTORS)) out.push([`actor ${k}`, t]);
  for (const [k, t] of Object.entries(GATES)) out.push([`gate ${k}`, t]);
  for (const [k, t] of Object.entries(CONDITIONS)) out.push([`condition ${k}`, t]);
  for (const s of STEPS) {
    out.push([`${s.id} title`, s.title]);
    if (s.needs) out.push([`${s.id} needs`, s.needs]);
    if (s.action) out.push([`${s.id} action`, s.action]);
    for (const [i, t] of (s.tasks ?? []).entries()) out.push([`${s.id} task ${i + 1}`, t.title]);
  }
  return out;
}

describe("the onboarding plan (src/onboarding/plan.ts)", () => {
  it("step IDs are unique, stable (pinned with their checks) and name their phase", () => {
    assert.deepEqual(
      STEPS.map((s) => [s.id, s.done]),
      PINNED,
    );
    assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length);
    for (const s of STEPS) assert.equal(s.id[0], s.phase === "base" ? "B" : "S", s.id);
    // The phases in order: no base step after a setup step.
    const phases = STEPS.map((s) => PHASES.findIndex((p) => p.id === s.phase));
    assert.deepEqual(phases, [...phases].sort((a, b) => a - b));
  });

  it("dependencies exist and come earlier (so they are acyclic); every step but B01 leads back to it", () => {
    for (const [i, s] of STEPS.entries()) {
      for (const d of s.dependsOn) {
        const at = STEPS.findIndex((x) => x.id === d);
        assert.ok(at >= 0, `${s.id} depends on the unknown step ${d}`);
        assert.ok(at < i, `${s.id} depends on ${d}, which comes after it`);
      }
      assert.equal(new Set(s.dependsOn).size, s.dependsOn.length, `${s.id} names a dependency twice`);
    }
    const reaches = (id: string): boolean => id === "B01" || stepById(id)!.dependsOn.some(reaches);
    for (const s of STEPS) assert.ok(reaches(s.id), s.id);
  });

  it("every text has English and Czech, and they differ", () => {
    for (const [what, t] of texts()) {
      assert.ok(t.en.trim(), `${what}: no English`);
      assert.ok(t.cs.trim(), `${what}: no Czech`);
      assert.notEqual(t.en, t.cs, `${what}: the Czech is the English`);
    }
  });

  it("every check is described, every described check used; commands use known placeholders; per-environment steps use <env>", () => {
    assert.deepEqual(Object.keys(CHECKS).sort(), [...CHECK_IDS].sort());
    assert.deepEqual([...new Set(STEPS.map((s) => s.done))].sort(), [...CHECK_IDS].sort());
    for (const s of STEPS) {
      const all = [...s.commands, ...(s.tasks ?? []).flatMap((t) => t.commands)].map((c) => c.run);
      for (const t of [...all, s.action?.en ?? "", s.needs?.en ?? "", s.pipeline ?? ""]) {
        for (const m of t.matchAll(/<([^<>]+)>/g)) assert.ok(PLACEHOLDERS.has(m[1]!), `${s.id}: unknown placeholder <${m[1]}>`);
      }
      if (s.forEach) assert.ok(all.some((c) => c.includes("<env>")) || s.pipeline?.includes("<env>"), `${s.id} runs per environment but names no <env>`);
      // A command that changes something is marked, so the AI guide asks first.
      for (const c of [...s.commands, ...(s.tasks ?? []).flatMap((t) => t.commands)]) if (/\s--apply\b/.test(c.run)) assert.equal(c.changes, true, `${s.id}: ${c.run}`);
      assert.ok(s.commands.length || s.action || s.tasks?.length, `${s.id} says nothing to do`);
    }
  });

  it("every runbook anchor resolves (tools/scripts/check-markdown-links.mjs)", () => {
    const dir = tmp("pc-onb-links-");
    const lines = STEPS.map((s) => {
      const [file, anchor] = s.runbook.split("#");
      assert.ok(existsSync(join(REPO_ROOT, file!)), `${s.id}: ${file} does not exist`);
      assert.ok(anchor, `${s.id}: ${s.runbook} has no anchor`);
      return `- [${s.id}](${relative(dir, join(REPO_ROOT, file!))}#${anchor})`;
    });
    writeFileSync(join(dir, "links.md"), `# Runbook links\n\n${lines.join("\n")}\n`);
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "tools", "scripts", "check-markdown-links.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("src/onboarding imports nothing from Node (the portal bundles it), and package.json exports it", () => {
    for (const f of readdirSync(join(PKG_ROOT, "src", "onboarding"))) {
      const text = readFileSync(join(PKG_ROOT, "src", "onboarding", f), "utf8");
      for (const m of text.matchAll(/^(?:import|export)[^"']*from "([^"]+)"/gm)) assert.match(m[1]!, /^\.\/[a-z-]+\.js$/, `${f} imports ${m[1]}`);
    }
    const pkg = read(join(PKG_ROOT, "package.json"));
    assert.deepEqual(pkg.exports["./onboarding"], { types: "./dist/src/onboarding/index.d.ts", default: "./dist/src/onboarding/index.js" });
    const app = tmp("pc-onb-consumer-");
    mkdirSync(join(app, "node_modules", "@simple-apps-foundry"), { recursive: true });
    symlinkSync(PKG_ROOT, join(app, "node_modules", "@simple-apps-foundry", "platform-cli"));
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
    writeFileSync(join(app, "main.js"), 'import { STEPS, PHASES } from "@simple-apps-foundry/platform-cli/onboarding";\nprocess.stdout.write(`${PHASES.length} ${STEPS.length}`);\n');
    const r = spawnSync(process.execPath, ["main.js"], { cwd: app, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${PHASES.length} ${STEPS.length}`);
  });
});

describe("the runbook's step-by-step checklist", () => {
  it("docs/runbooks/onboard-instance.md has the generated checklist between its markers", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    assert.equal(planBlockOf(text), planMarkdownBlock(), `${RUNBOOK} is out of date: platform instance plan --format markdown --update docs/runbooks/onboard-instance.md`);
  });

  it("plan --update rewrites only the block, and refuses a file without the markers", () => {
    const dir = tmp("pc-onb-update-");
    const file = join(dir, "runbook.md");
    writeFileSync(file, `# Runbook\n\nIntro.\n\n${PLAN_BLOCK_START} old -->\nstale\n${PLAN_BLOCK_END}\n\n## Details\n`);
    const r = cli(["instance", "plan", "--format", "markdown", "--update", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^updated /);
    assert.equal(readFileSync(file, "utf8"), `# Runbook\n\nIntro.\n\n${planMarkdownBlock()}\n\n## Details\n`);
    assert.match(cli(["instance", "plan", "--format", "markdown", "--update", file]).stdout, /^unchanged /);
    writeFileSync(file, "# No markers\n");
    const none = cli(["instance", "plan", "--format", "markdown", "--update", file]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /has no onboarding-plan markers/);
    assert.equal(cli(["instance", "plan", "--update", file]).code, 2);
  });
});

describe("platform instance plan", () => {
  it("text: every phase and step; --instance fills the host and lists each environment", () => {
    const generic = cli(["instance", "plan"]);
    assert.equal(generic.code, 0, generic.stderr);
    for (const s of STEPS) assert.match(generic.stdout, new RegExp(`^  ${s.id}  `, "m"));
    assert.match(generic.stdout, /^ {7}\$ instance\.sh bootstrap <host>$/m);
    const filled = cli(["instance", "plan", "--instance", EXAMPLE]);
    assert.equal(filled.code, 0, filled.stderr);
    assert.match(filled.stdout, /^ {7}\$ instance\.sh bootstrap prod$/m);
    assert.match(filled.stdout, /^ {7}\$ instance\.sh bootstrap prod --pass 2\n {7}\$ instance\.sh bootstrap prod --pass 2 --apply --remove-lock\n {7}\$ instance\.sh bootstrap nonprod --pass 2$/m);
    assert.match(filled.stdout, /id-contoso-portal/);
    assert.match(cli(["instance", "plan", "--lang", "cs"]).stdout, /^Fáze base: Základní nasazení/m);
  });

  it("json: the definition with both languages; usage errors exit 2", () => {
    const r = cli(["instance", "plan", "--format", "json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as Doc;
    assert.equal(j.formatVersion, 1);
    assert.deepEqual(
      j.steps.map((s: Doc) => s.id),
      STEPS.map((s) => s.id),
    );
    assert.equal(j.steps.find((s: Doc) => s.id === "S01").tasks.length, 3);
    for (const args of [["--format", "html"], ["--lang", "de"], ["extra"]]) assert.equal(cli(["instance", "plan", ...args]).code, 2, args.join(" "));
  });
});

/** Every deployment, every plan ok and the portal ready: the state of a deployed instance (the fixtures). */
function deployedState(o: OnboardingInstance): OnboardingState {
  const outputs = (f: string): Record<string, unknown> => deploymentOutputs(read(join(S, f)), f);
  const ok = (out: Record<string, unknown> = {}, federation: unknown = null): DeploymentRead => ({ state: "succeeded", provisioningState: "Succeeded", outputs: out, federation });
  const fed = read(join(S, "connections.json")).federation as Doc;
  const row = (status: "ok", kind: string, text: string): { status: "ok"; kind: string; text: string } => ({ status, kind, text });
  const okPhase = (rows = [row("ok", "project", "Platform")], output: Doc = {}): { read: "ok"; rows: typeof rows; output: Doc; exitCode: number } => ({ read: "ok", rows, output, exitCode: 0 });
  return {
    azure: { login: "ok" },
    providers: Object.fromEntries(o.environments.map((e) => [e.subscriptionId, { missing: [] }])),
    deployments: {
      [o.names.bootstrap.prod!]: ok(outputs("bootstrap-prod.outputs.json"), fed.prod),
      [o.names.bootstrap.nonprod!]: ok(outputs("bootstrap-nonprod.outputs.json"), fed.nonprod),
      [o.names.platform.prod!]: ok(outputs("platform-prod.outputs.json")),
      [o.names.platform.nonprod!]: ok(outputs("platform-prod.outputs.json")),
      [o.names.roles]: ok(),
      [o.names.entraPermissions]: ok(),
      [o.names.portal]: ok({ ...outputs("portal-prod.outputs.json"), containerApp: { name: "ca-contoso-portal" } }),
      [o.names.registration]: ok(outputs("entra-portal-prod.outputs.json")),
      [o.names.auditAlert]: ok(),
    },
    dnsZones: { "contoso.com": { state: "exists" } },
    dnsRoles: { "contoso.com": { prod: { state: "ok", detail: "DNS Zone Contributor on the zone" }, nonprod: { state: "ok", detail: "Contributor on its subscription" } } },
    ado: {
      token: "ok",
      phases: {
        projects: okPhase(),
        core: okPhase(undefined, { core: { repository: { id: "x", name: "core" }, tags: ["v0.1.0"] } }),
        config: okPhase([row("ok", "repository", "Platform/platform-config (x)"), row("ok", "seed", "Platform/platform-config: refs/heads/main (instance.yaml on refs/heads/main equals instance.yaml)")]),
        connections: okPhase(undefined, read(join(S, "connections.json"))),
        pipeline: okPhase(undefined, { pipeline: { id: 1 }, validationPipeline: { id: 2 }, platformPipelines: { prod: { id: 3 }, nonprod: { id: 4 } } }),
        grants: okPhase(),
        policies: okPhase(),
      },
    },
    portal: { url: "https://portal.contoso.com", readyz: 200 },
    auditAlertWorkspace: "/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-contoso-platform-prod/providers/Microsoft.OperationalInsights/workspaces/log-contoso-prod",
    apps: ["hotel-inventory"],
  };
}
const statusOf = (r: OnboardingReport, id: string): string => r.steps.find((s) => s.id === id)!.status;

describe("where onboarding stands (evaluateOnboarding)", () => {
  it("a deployed instance with a first app: complete; without the app: B32 next", () => {
    const o = inst();
    const st = deployedState(o);
    const done = evaluateOnboarding(o, st);
    assert.deepEqual(
      done.steps.filter((s) => s.status !== "done").map((s) => `${s.id} ${s.status}: ${s.reason}`),
      [],
    );
    assert.equal(done.currentPhase, "complete");
    assert.equal(done.currentStep, undefined);
    assert.deepEqual(
      done.phases.map((p) => [p.id, p.done, p.total]),
      [
        ["base", 32, 32],
        ["setup", 1, 1],
      ],
    );
    const noApp = evaluateOnboarding(o, { ...st, apps: [] });
    assert.deepEqual([noApp.currentPhase, noApp.currentStep, noApp.nextStep, statusOf(noApp, "B32")], ["base", "B32", "B32", "next"]);
  });

  it("nothing read: Azure steps unknown, the confirmed requests wait on their teams, later steps blocked", () => {
    const r = evaluateOnboarding(inst(), {});
    assert.equal(r.currentStep, "B02");
    assert.equal(r.steps.find((s) => s.id === "B02")!.waitingOn, "securityTeam");
    assert.equal(statusOf(r, "B03"), "unknown");
    assert.match(r.steps.find((s) => s.id === "B03")!.reason, /Azure was not read/);
    // B09 depends on a request nothing records (B07): it goes on, naming the assumption.
    assert.deepEqual(r.steps.find((s) => s.id === "B09")!.assumes, ["B07"]);
    assert.deepEqual(r.steps.find((s) => s.id === "B12")!.blockedBy, ["B04"]);
    assert.equal(r.nextStep, undefined);
  });

  it("an invalid instance.yaml: B01 next with the problems, every other step blocked", () => {
    const r = evaluateOnboarding(undefined, {}, ["instance.yaml naming.prefix: must match pattern."]);
    assert.deepEqual([r.currentStep, r.nextStep, r.problems], ["B01", "B01", ["instance.yaml naming.prefix: must match pattern."]]);
    assert.deepEqual(r.steps[0]!.details, ["instance.yaml naming.prefix: must match pattern."]);
    for (const s of r.steps.slice(1)) assert.equal(s.status, "blocked", s.id);
  });

  it("steps that don't apply are done (not needed): one environment, separate Entra approval, no Azure DNS zone, VNet only", () => {
    const o = inst();
    const small: OnboardingInstance = {
      ...o,
      environments: o.environments.filter((e) => e.name === o.host).map((e) => ({ ...e, managedNetwork: false })),
      entraChanges: "separate",
      azureDnsZones: [],
    };
    const r = evaluateOnboarding(small, {});
    for (const id of ["B02", "B08", "B13", "B14", "B24"]) {
      const s = r.steps.find((x) => x.id === id)!;
      assert.deepEqual([s.status, s.notNeeded], ["done", true], id);
    }
  });

  it("the portal's own host name (ADR-0071): no pass 1 before the registration; without one, B27 first", () => {
    const o = inst();
    assert.equal(o.portalHostName, "portal.contoso.com");
    const own = evaluateOnboarding(o, {}).steps.find((s) => s.id === "B27")!;
    assert.deepEqual([own.status, own.notNeeded], ["done", true]);
    const noHost = evaluateOnboarding({ ...o, portalHostName: "" }, {}).steps.find((s) => s.id === "B27")!;
    assert.notEqual(noHost.notNeeded, true);
  });

  it("next carries the exact commands; waiting names whom; a per-environment step only the environments not done", () => {
    const o = inst();
    const st = deployedState(o);
    st.deployments![o.names.platform.nonprod!] = { state: "absent" };
    st.dnsRoles!["contoso.com"]!.nonprod = { state: "missing", detail: "00000000-0000-0000-0000-00000000f002" };
    st.ado!.phases.grants = { read: "ok", exitCode: 1, rows: [{ status: "blocked", kind: "org-user", text: "id-contoso-portal (in the organization)  (not in the organization)" }] };
    const r = evaluateOnboarding(o, st);
    const step = (id: string): OnboardingReport["steps"][number] => r.steps.find((s) => s.id === id)!;
    assert.equal(step("B25").status, "next");
    assert.deepEqual(step("B25").commands, []);
    assert.match(step("B25").action!, /`\\platform\\platform-nonprod`/);
    assert.doesNotMatch(step("B25").action!, /platform-prod/);
    assert.ok(step("B14").commands.some((c) => c.changes && c.run.includes("--assignee-object-id 00000000-0000-0000-0000-00000000f002")));
    assert.deepEqual([step("B22").status, step("B22").waitingOn], ["waiting", "adoAdmins"]);
    assert.match(step("B22").details.join(" "), /blocked org-user id-contoso-portal/);

    // Pass 2 with another federation than the connections have now: only that environment's commands.
    const stale = deployedState(o);
    stale.deployments![o.names.bootstrap.nonprod!] = { ...stale.deployments![o.names.bootstrap.nonprod!]!, federation: { provisioning: { issuer: "i", subject: "old" } } };
    const b19 = evaluateOnboarding(o, stale).steps.find((s) => s.id === "B19")!;
    assert.equal(b19.status, "next");
    assert.deepEqual(
      b19.commands.map((c) => [c.run, c.changes ?? false]),
      [
        ["instance.sh bootstrap nonprod --pass 2", false],
        ["instance.sh bootstrap nonprod --pass 2 --apply --remove-lock", true],
      ],
    );
  });

  it("unknown says why: no token, a deployment that can't be read, a portal that can't be reached", () => {
    const o = inst();
    const st = deployedState(o);
    st.ado = { token: "missing", error: "az login, or export AZURE_DEVOPS_TOKEN", phases: {} };
    st.deployments![o.names.roles] = { state: "unknown", error: "ERROR: (AuthorizationFailed) no read" };
    st.portal = { url: "https://portal.contoso.com", error: "curl: (6) Could not resolve host" };
    const r = evaluateOnboarding(o, st);
    const reason = (id: string): string => `${statusOf(r, id)}: ${r.steps.find((s) => s.id === id)!.reason}`;
    assert.match(reason("B09"), /^unknown: no Azure DevOps token \(az login/);
    assert.match(reason("B20"), /^unknown: could not read the deployment roles-contoso: ERROR: \(AuthorizationFailed\)/);
    assert.match(reason("B31"), /^unknown: could not reach https:\/\/portal\.contoso\.com\/readyz/);
    // What depends on an unknown step waits for it.
    assert.equal(reason("B15"), "blocked: waits for B10");
  });

  it("the setup phase: email next with the Exchange commands filled in from the portal identity", () => {
    const o = { ...inst(), email: undefined };
    const r = evaluateOnboarding(o, deployedState(o));
    const s = r.steps.find((x) => x.id === "S01")!;
    assert.equal(s.status, "next");
    assert.ok(s.commands.some((c) => c.run === 'New-ServicePrincipal -AppId 00000000-0000-0000-0000-00000000f041 -ObjectId 00000000-0000-0000-0000-00000000e102 -DisplayName "SAF portal (id-contoso-portal)"'));
    assert.ok(s.commands.some((c) => c.run.includes("<sender>")), "the sender is not known yet");
  });

  it("the plan rows of platform ado bootstrap: formatItems and parseItemRows agree", () => {
    const items: Item[] = [
      { status: "create", kind: "repository", name: "Platform/core", detail: "then seeded" },
      { status: "ok", kind: "pipeline-permission", name: "endpoint sc-platform-entra" },
      { status: "blocked", kind: "policy", name: "sc-platform-entra: approval by pull request review", detail: "run --phase policies" },
    ];
    assert.deepEqual(parseItemRows(`platform ado bootstrap plan --phase core (https://dev.azure.com/contoso)\n${formatItems(items, false)}Federation for x:\n`), [
      { status: "create", kind: "repository", text: "Platform/core  (then seeded)" },
      { status: "ok", kind: "pipeline-permission", text: "endpoint sc-platform-entra" },
      { status: "blocked", kind: "policy", text: "sc-platform-entra: approval by pull request review  (run --phase policies)" },
    ]);
  });
});

describe("platform instance status", () => {
  it("reads the state directory of instance.sh status; json and text", () => {
    const dir = tmp("pc-onb-state-");
    const st = join(dir, "state");
    for (const d of ["deployments", "providers", "ado", "portal", "dns"]) mkdirSync(join(st, d), { recursive: true });
    writeFileSync(join(st, "azure"), "ok\n");
    writeFileSync(join(st, "providers", "00000000-0000-0000-0000-00000000a001.missing"), "Microsoft.Cdn\n");
    writeFileSync(join(st, "providers", "00000000-0000-0000-0000-00000000b001.missing"), "");
    writeFileSync(join(st, "deployments", "bootstrap-contoso-prod.json"), JSON.stringify({ state: "Succeeded", outputs: read(join(S, "bootstrap-prod.outputs.json")), federation: null }));
    writeFileSync(join(st, "deployments", "bootstrap-contoso-nonprod.absent"), "");
    writeFileSync(join(st, "deployments", "roles-contoso.error"), "ERROR: (AuthorizationFailed) no\nsecond line\n");
    writeFileSync(join(st, "dns", "contoso.com.absent"), "");
    writeFileSync(join(st, "ado", "token.error"), "az login, or export AZURE_DEVOPS_TOKEN\n");
    cpSync(EXAMPLE, join(dir, "instance.yaml"));
    const status = (): OnboardingReport => {
      const r = cli(["instance", "status", "--instance", join(dir, "instance.yaml"), "--state", st, "--format", "json"]);
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout) as OnboardingReport;
    };
    const j = status();
    assert.equal(j.nextStep, "B04");
    assert.deepEqual(j.steps.find((s) => s.id === "B04")!.details, ["00000000-0000-0000-0000-00000000a001: Microsoft.Cdn"]);
    assert.equal(j.steps.find((s) => s.id === "B12")!.status, "done");
    assert.deepEqual(j.steps.find((s) => s.id === "B20")!.blockedBy, ["B04"]);
    writeFileSync(join(st, "providers", "00000000-0000-0000-0000-00000000a001.missing"), "");
    const after = status();
    assert.equal(after.nextStep, "B08");
    assert.match(after.steps.find((s) => s.id === "B20")!.reason, /could not read the deployment roles-contoso: ERROR: \(AuthorizationFailed\) no second line/);
    writeFileSync(join(st, "providers", "00000000-0000-0000-0000-00000000a001.missing"), "Microsoft.Cdn\n");
    const text = cli(["instance", "status", "--instance", join(dir, "instance.yaml"), "--state", st, "--lang", "cs"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^Onboarding of contoso \(core v0\.1\.0\): phase base, step B02 \(Získej od bezpečnostního týmu/m);
    assert.match(text.stdout, /^Next: B04 /m);
    assert.match(text.stdout, /^ {11}\$ instance\.sh providers --apply$/m);
  });

  it("an invalid instance.yaml is step B01, not an error; a missing file and bad options are", () => {
    const dir = tmp("pc-onb-invalid-");
    const doc = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
    doc.naming.prefix = "Not-Valid";
    writeFileSync(join(dir, "instance.yaml"), stringify(doc));
    const r = cli(["instance", "status", "--instance", join(dir, "instance.yaml"), "--format", "json"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as OnboardingReport;
    assert.equal(j.currentStep, "B01");
    assert.match(j.problems!.join(" "), /naming/);
    assert.equal(cli(["instance", "status", "--instance", join(dir, "missing.yaml")]).code, 1);
    assert.equal(cli(["instance", "status"]).code, 2);
    assert.equal(cli(["instance", "status", "--instance", EXAMPLE, "--format", "markdown"]).code, 2);
    assert.equal(cli(["instance", "status", "--instance", EXAMPLE, "--state", join(dir, "nope")]).code, 2);
  });
});

describe("the AI guide in platform-config (platform generate)", () => {
  function configDir(instanceText = readFileSync(EXAMPLE, "utf8")): string {
    const dir = tmp("pc-onb-guide-");
    writeFileSync(join(dir, "instance.yaml"), instanceText);
    return dir;
  }

  it("generate writes AGENTS.md, CLAUDE.md, the skill in .agents/ and the same bytes in .claude/, and the tool stubs; --check passes after it", () => {
    const dir = configDir();
    const r = cli(["generate", "--config-dir", dir]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const f of AI_GUIDE_FILES) assert.match(r.stdout, new RegExp(`^created +${f.replace(/\./g, "\\.")}$`, "m"), f);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.deepEqual(readFileSync(join(dir, ".claude/skills/onboard-instance/SKILL.md")), readFileSync(join(dir, ".agents/skills/onboard-instance/SKILL.md")));
    assert.match(readFileSync(join(dir, ".agents/skills/onboard-instance/SKILL.md"), "utf8"), /^---\nname: onboard-instance\ndescription: Use when /);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".gemini/settings.json"), "utf8")), { context: { fileName: ["AGENTS.md"] } });
    assert.match(readFileSync(join(dir, ".github/copilot-instructions.md"), "utf8"), /\[AGENTS\.md\]\(\.\.\/AGENTS\.md\)/);
    assert.equal(cli(["generate", "--config-dir", dir, "--check"]).code, 0);
  });

  it("the guide's rules: the plan and status first, one step at a time, --apply after a yes, never approve, instance.yaml by pull request, the person's language", () => {
    const files = Object.fromEntries(aiGuideFiles().map((f) => [f.path, f.text]));
    const agents = files["AGENTS.md"]!;
    const skill = files[".agents/skills/onboard-instance/SKILL.md"]!;
    for (const [what, re] of [
      ["the plan first", /Run `instance\.sh plan`/],
      ["then status", /Run `instance\.sh status --format json`/],
      ["the current phase", /\*\*current phase\*\* \(`currentPhase`\)/],
      ["one step at a time", /^## 3\. One step at a time$/m],
      ["--apply only after a yes", /only after the person said yes to this\s+step/],
      ["never approve", /never approve, vote or complete for them/],
      ["instance.yaml through a pull request", /^## 4\. instance\.yaml changes only through a pull request$/m],
      ["the setup phase as the portal would", /written as the portal's Settings would write them/],
      ["the person's language", /Report in the person's language/],
    ] as const) {
      assert.match(skill, re, what);
    }
    assert.match(agents, /Never approve for the person/);
    assert.match(agents, /Load the skill `onboard-instance`/);
  });

  it("the same for every instance: no value of instance.yaml goes in (a settings pull request never changes it)", () => {
    const doc = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
    doc.naming.prefix = "fabrikam";
    doc.coreVersion = "v9.9.9";
    doc.notifications.email.sender = "noreply@fabrikam.example";
    const a = configDir();
    const b = configDir(stringify(doc));
    assert.equal(cli(["generate", "--config-dir", a]).code, 0);
    assert.equal(cli(["generate", "--config-dir", b]).code, 0);
    for (const f of AI_GUIDE_FILES) assert.deepEqual(readFileSync(join(a, f)), readFileSync(join(b, f)), f);
    for (const f of aiGuideFiles()) assert.doesNotMatch(f.text, /contoso|fabrikam|00000000-/, f.path);
  });

  it("--check of a platform-config without the guide (an existing instance) says what to run", () => {
    const dir = configDir();
    assert.equal(cli(["generate", "--config-dir", dir]).code, 0);
    for (const f of AI_GUIDE_FILES) rmSync(join(dir, f));
    const r = cli(["generate", "--config-dir", dir, "--check"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^DRIFT +AGENTS\.md \(missing\)$/m);
    assert.match(r.stdout, /The AI guide \(AGENTS\.md, CLAUDE\.md, the skill onboard-instance .* is missing/);
    assert.match(r.stdout, /Fix: in a clone of platform-config, run "platform generate --config-dir \." with the CLI of coreVersion and commit every file it writes in a pull request/);
    // A hand-edited guide is ordinary drift.
    assert.equal(cli(["generate", "--config-dir", dir]).code, 0);
    writeFileSync(join(dir, "AGENTS.md"), "# my own\n");
    const edited = cli(["generate", "--config-dir", dir, "--check"]);
    assert.equal(edited.code, 1);
    assert.match(edited.stdout, /^DRIFT +AGENTS\.md$/m);
    assert.match(edited.stdout, /^Fix: run "platform generate" and commit the result\.$/m);
  });

  it("a symbolic link on the way is refused, nothing written outside platform-config", () => {
    const dir = configDir();
    const outside = tmp("pc-onb-outside-");
    symlinkSync(outside, join(dir, ".claude"));
    const r = cli(["generate", "--config-dir", dir]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.claude is a symbolic link, which is not allowed/);
    assert.deepEqual(readdirSync(outside), []);
    assert.deepEqual(readdirSync(dir), [".claude", "instance.yaml"]);
  });
});
