import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { tmp } from "./helpers.js";
import { VSO, instanceFile, pipe, readJsonFile } from "./pipeline-helpers.js";
import { promotionProblems } from "../src/pipeline/instance.js";
import type { EnvParam } from "../src/pipeline/common.js";

const okParams = {
  app: { slug: "demo", defaultBranch: "refs/heads/main" },
  environments: [{ name: "nonprod", kind: "nonprod", promoteFrom: "" }],
  action: "deliver",
  targetEnvironment: "none",
  sourceRunId: 0,
};
const CORE_REF = "refs/tags/v0.1.0"; // coreVersion of config/examples/instance.example.yaml

function run(params: unknown, extraEnv: Record<string, string> = {}, inst = instanceFile()) {
  return pipe(["validate-run", "--instance", inst], {
    SAF_PARAMS_JSON: typeof params === "string" ? params : JSON.stringify(params),
    RESOURCES_REPOSITORIES_CORE_REF: CORE_REF,
    ...extraEnv,
  });
}

function lines(stderr: string): string[] {
  return stderr.trim().split("\n").filter(Boolean);
}

describe("pipeline validate-run", () => {
  it("accepts parameters that match instance.yaml and prints one OK line", () => {
    const r = run(okParams);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK {2}deliver: app demo \(default branch refs\/heads\/main\), environments nonprod\/nonprod, core refs\/tags\/v0\.1\.0\n$/);
    assert.equal(r.stderr, "");
  });

  it("fails on an invalid instance.yaml (schema validation, prefixed lines)", () => {
    const r = run(okParams, {}, instanceFile((d) => (d.naming.prefix = "Bad-Prefix")));
    assert.equal(r.code, 1);
    assert.ok(lines(r.stderr).every((l) => l.startsWith("platform pipeline validate-run: ")));
    assert.match(r.stderr, /naming\.prefix/);
  });

  it("rejects extra or missing keys in app and environments", () => {
    const r = run({ app: { slug: "demo", defaultBranch: "refs/heads/main", extra: true }, environments: [{ name: "nonprod", kind: "nonprod" }] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /parameters\.app has an unknown key "extra"/);
    assert.match(r.stderr, /parameters\.environments\[0\] is missing "promoteFrom"/);
    const top = run({ ...okParams, steps: [] });
    assert.equal(top.code, 1);
    assert.match(top.stderr, /parameters has an unknown key "steps"/);
  });

  describe("action, targetEnvironment, sourceRunId", () => {
    const both = [...okParams.environments, { name: "prod", kind: "prod", promoteFrom: "nonprod" }];

    it("requires all five parameters", () => {
      const { action: _a, ...four } = okParams;
      const r = run(four);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /parameters is missing "action"/);
    });

    it("accepts a redeploy to an environment of the list with a source run", () => {
      for (const target of ["nonprod", "prod"]) {
        const r = run({ ...okParams, environments: both, action: "redeploy", targetEnvironment: target, sourceRunId: 2874 });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^OK {2}redeploy of run 2874 to ${target}: app demo`));
      }
      assert.equal(run({ ...okParams, action: "redeploy", targetEnvironment: "nonprod", sourceRunId: "2874" }).code, 0, "digit string");
    });

    it("rejects a redeploy without a target, without a source run, or to an environment outside the list", () => {
      assert.match(run({ ...okParams, action: "redeploy", targetEnvironment: "none", sourceRunId: 2874 }).stderr, /action redeploy needs a targetEnvironment/);
      assert.match(run({ ...okParams, action: "redeploy", targetEnvironment: "nonprod", sourceRunId: 0 }).stderr, /action redeploy needs a sourceRunId/);
      assert.match(run({ ...okParams, action: "redeploy", targetEnvironment: "prod", sourceRunId: 1 }).stderr, /targetEnvironment "prod" is not one of this pipeline's environments \(nonprod\)/);
    });

    it("rejects a deliver with a target or a source run", () => {
      assert.match(run({ ...okParams, targetEnvironment: "nonprod" }).stderr, /action deliver takes no targetEnvironment/);
      assert.match(run({ ...okParams, sourceRunId: 5 }).stderr, /action deliver takes no sourceRunId/);
    });

    it("validates the types and values", () => {
      for (const bad of [
        { action: "rollback" },
        { action: true },
        { targetEnvironment: "Prod" },
        { targetEnvironment: 1 },
        { sourceRunId: -1 },
        { sourceRunId: 1.5 },
        { sourceRunId: "12a" },
        { sourceRunId: 2_147_483_648 },
        { sourceRunId: null },
      ]) {
        const r = run({ ...okParams, ...bad });
        assert.equal(r.code, 1, JSON.stringify(bad));
      }
    });
  });

  it("checks the slug and the default branch", () => {
    for (const slug of ["platform", "portal", "Demo", "ab", "a-very-long-app-name-x", "demo-", "de--mo"]) {
      const r = run({ ...okParams, app: { slug, defaultBranch: "refs/heads/main" } });
      assert.equal(r.code, 1, slug);
      assert.match(r.stderr, /parameters\.app\.slug/);
    }
    const b = run({ ...okParams, app: { slug: "demo", defaultBranch: "main" } });
    assert.equal(b.code, 1);
    assert.match(b.stderr, /defaultBranch must be a branch ref/);
  });

  it("compares every environment with instance.yaml (kind, promoteFrom, unknown, duplicates)", () => {
    const kind = run({ ...okParams, environments: [{ name: "nonprod", kind: "prod", promoteFrom: "" }] });
    assert.equal(kind.code, 1);
    assert.match(kind.stderr, /has kind "prod", instance\.yaml says "nonprod"/);
    const unknown = run({ ...okParams, environments: [{ name: "test", kind: "nonprod", promoteFrom: "" }] });
    assert.match(unknown.stderr, /"test" is not an environment of this instance/);
    const dup = run({ ...okParams, environments: [okParams.environments[0], okParams.environments[0]] });
    assert.match(dup.stderr, /listed more than once/);
    const pf = run({ ...okParams, environments: [{ name: "prod", kind: "prod", promoteFrom: "" }] });
    assert.match(pf.stderr, /promoteFrom "", instance\.yaml says "nonprod"/);
    const empty = run({ ...okParams, environments: [] });
    assert.match(empty.stderr, /at least one environment/);
  });

  it("accepts promotion environments that match instance.yaml", () => {
    const r = run({ ...okParams, environments: [...okParams.environments, { name: "prod", kind: "prod", promoteFrom: "nonprod" }] });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /environments nonprod\/nonprod, prod\/prod \(from nonprod\), core/);
  });

  it("accepts a three-environment chain dev -> test -> prod", () => {
    const inst = instanceFile((d) => {
      const [nonprod, prod] = d.environments;
      d.environments = [
        { ...nonprod, name: "dev" },
        { ...nonprod, name: "test", promoteFrom: "dev" },
        { ...prod, name: "prod", promoteFrom: "test" },
      ] as never;
      delete d.frontDoor;
    });
    const envs = [
      { name: "dev", kind: "nonprod", promoteFrom: "" },
      { name: "test", kind: "nonprod", promoteFrom: "dev" },
      { name: "prod", kind: "prod", promoteFrom: "test" },
    ];
    const r = run({ ...okParams, environments: envs }, {}, inst);
    assert.equal(r.code, 0, r.stderr);
  });

  it("requires promoteFrom to be in the list (a promotion environment without its source fails)", () => {
    const r = run({ ...okParams, environments: [{ name: "prod", kind: "prod", promoteFrom: "nonprod" }] });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"prod" promotes from "nonprod", which is not in this pipeline's environment list/);
  });

  it("rejects self-promotion and cycles", () => {
    const self = instanceFile((d) => {
      d.environments.push({ ...d.environments[0], name: "loop", promoteFrom: "loop" } as never);
    });
    const r = run({ ...okParams, environments: [{ name: "loop", kind: "nonprod", promoteFrom: "loop" }] }, {}, self);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"loop" cannot promote from itself/);

    const cyc = instanceFile((d) => {
      d.environments.push({ ...d.environments[0], name: "aa", promoteFrom: "bb" } as never, { ...d.environments[0], name: "bb", promoteFrom: "aa" } as never);
    });
    const c = run({ ...okParams, environments: [{ name: "aa", kind: "nonprod", promoteFrom: "bb" }, { name: "bb", kind: "nonprod", promoteFrom: "aa" }] }, {}, cyc);
    assert.equal(c.code, 1);
    assert.match(c.stderr, /promoteFrom forms a cycle \(aa -> bb -> aa\)/);
    assert.equal((c.stderr.match(/cycle/g) ?? []).length, 1, "one cycle is reported once");
  });

  it("promotionProblems: chains, self, missing sources and longer cycles", () => {
    const e = (name: string, promoteFrom = ""): EnvParam => ({ name, kind: "nonprod", promoteFrom });
    assert.deepEqual(promotionProblems([e("dev"), e("test", "dev"), e("prod", "test")]), []);
    assert.deepEqual(promotionProblems([e("dev"), e("qa", "dev"), e("uat", "dev")]), []);
    assert.equal(promotionProblems([e("a", "a")]).length, 1);
    assert.equal(promotionProblems([e("a", "zz")]).length, 1);
    const three = promotionProblems([e("dev"), e("a", "c"), e("b", "a"), e("c", "b"), e("d", "a")]);
    assert.equal(three.length, 1);
    assert.match(three[0] ?? "", /cycle/);
  });

  it("allows a subset of the instance environments", () => {
    const inst = instanceFile((d) => {
      d.environments.push({ ...d.environments[0], name: "test" } as never);
    });
    const r = run({ ...okParams, environments: [{ name: "test", kind: "nonprod", promoteFrom: "" }] }, {}, inst);
    assert.equal(r.code, 0, r.stderr);
  });

  it("requires the core ref to be the pinned tag", () => {
    const wrong = run(okParams, { RESOURCES_REPOSITORIES_CORE_REF: "refs/heads/main" });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /pins coreVersion v0\.1\.0 \(expected refs\/tags\/v0\.1\.0\)/);
    const unset = run(okParams, { RESOURCES_REPOSITORIES_CORE_REF: "" });
    assert.match(unset.stderr, /RESOURCES_REPOSITORIES_CORE_REF is not set/);
  });

  it("fails on missing or broken SAF_PARAMS_JSON, and on usage errors with exit 2", () => {
    assert.match(pipe(["validate-run", "--instance", instanceFile()], { RESOURCES_REPOSITORIES_CORE_REF: CORE_REF }).stderr, /SAF_PARAMS_JSON is not set/);
    const bad = run("{not json");
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /SAF_PARAMS_JSON is not valid JSON/);
    assert.equal(run("[]").code, 1);
    assert.equal(pipe(["validate-run"]).code, 2);
    assert.equal(pipe(["validate-run", "--instance", "x", "--bogus"]).code, 2);
    assert.equal(pipe(["no-such-command"]).code, 2);
  });

  it("neutralises logging commands in its error output", () => {
    const r = run({ ...okParams, app: { slug: `${VSO}task.setvariable variable=x]1`, defaultBranch: "refs/heads/main" } });
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.toLowerCase().includes(VSO), r.stderr);
    assert.match(r.stderr, /#​#vso\[/);
  });
});

describe("pipeline instance-env", () => {
  it("writes the environment with defaults resolved", () => {
    const out = join(tmp(), "env.json");
    const r = pipe(["instance-env", "--instance", instanceFile(), "--env", "nonprod", "--output", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJsonFile(out), {
      prefix: "contoso",
      name: "nonprod",
      kind: "nonprod",
      subscriptionId: "00000000-0000-0000-0000-00000000a001",
      region: "westeurope",
      promoteFrom: "",
      vaultGeneration: 0,
      coreVersion: "v0.1.0",
    });
  });

  it("uses the environment's own region, vaultGeneration and promoteFrom", () => {
    const out = join(tmp(), "env.json");
    const inst = instanceFile((d) => {
      const prod = d.environments.find((e) => e.name === "prod");
      if (prod) {
        prod.region = "northeurope";
        prod.vaultGeneration = 2;
      }
    });
    assert.equal(pipe(["instance-env", "--instance", inst, "--env", "prod", "--output", out]).code, 0);
    const e = readJsonFile(out) as Record<string, unknown>;
    assert.equal(e.region, "northeurope");
    assert.equal(e.vaultGeneration, 2);
    assert.equal(e.promoteFrom, "nonprod");
    assert.equal(e.kind, "prod");
  });

  it("fails for an unknown environment and requires --output", () => {
    const r = pipe(["instance-env", "--instance", instanceFile(), "--env", "qa", "--output", join(tmp(), "e.json")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^platform pipeline instance-env: instance\.yaml has no environment "qa"/);
    assert.equal(pipe(["instance-env", "--instance", instanceFile(), "--env", "nonprod"]).code, 2);
  });
});

describe("pipeline portal-target", () => {
  type Portal = { clientId?: string; apiBaseUrl?: string; [k: string]: unknown };
  const target = (mutate?: (portal: Portal) => void) => {
    const out = join(tmp(), "portal.json");
    const r = pipe(["portal-target", "--instance", instanceFile((d) => mutate?.(d.portal as Portal)), "--output", out]);
    return { ...r, json: r.code === 0 ? readJsonFile(out) : undefined };
  };

  it("writes clientId and apiBaseUrl from instance.yaml", () => {
    const r = target();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { clientId: "00000000-0000-0000-0000-00000000e101", apiBaseUrl: "https://portal.contoso.com" });
    assert.equal(r.stdout, "OK  portal API https://portal.contoso.com (audience api://00000000-0000-0000-0000-00000000e101)\n");
  });

  it("writes '' for a missing value and says what is missing (the report step then skips)", () => {
    const noUrl = target((p) => delete p.apiBaseUrl);
    assert.equal(noUrl.code, 0, noUrl.stderr);
    assert.deepEqual(noUrl.json, { clientId: "00000000-0000-0000-0000-00000000e101", apiBaseUrl: "" });
    assert.match(noUrl.stdout, /^SKIP {2}instance\.yaml has no portal\.apiBaseUrl: no deploy events for the portal \(ADR-0037\)$/m);
    const none = target((p) => {
      delete p.apiBaseUrl;
      delete p.clientId;
    });
    assert.deepEqual(none.json, { clientId: "", apiBaseUrl: "" });
    assert.match(none.stdout, /no portal\.clientId and portal\.apiBaseUrl:/);
  });

  it("fails on an invalid instance.yaml (schema) and requires --output", () => {
    const r = target((p) => (p.apiBaseUrl = "https://portal.contoso.com/api"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^platform pipeline portal-target: instance\.yaml line \d+: portal\.apiBaseUrl: has an invalid format/m);
    assert.equal(pipe(["portal-target", "--instance", instanceFile()]).code, 2);
  });
});
