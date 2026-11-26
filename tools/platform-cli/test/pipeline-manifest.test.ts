import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, write } from "./helpers.js";
import { PIPE, VSO, instanceFile, pipe, readJsonFile } from "./pipeline-helpers.js";
import { CheckFailed } from "../src/pipeline/common.js";
import { branchMatches, releaseInputs } from "../src/pipeline/manifest.js";

const ENVS = JSON.stringify([
  { name: "nonprod", kind: "nonprod", promoteFrom: "" },
  { name: "test", kind: "nonprod", promoteFrom: "" },
]);
const ONE_ENV = JSON.stringify([{ name: "nonprod", kind: "nonprod", promoteFrom: "" }]);

/** An app checkout with the fixture platform.yaml (or the given text) and docker/Dockerfile. */
function appDir(manifest?: string): string {
  const dir = join(tmp("pc-app-"), "app");
  mkdirSync(join(dir, "docker"), { recursive: true });
  if (manifest === undefined) copyFileSync(join(PIPE, "platform.yaml"), join(dir, "platform.yaml"));
  else writeFileSync(join(dir, "platform.yaml"), manifest);
  writeFileSync(join(dir, "docker", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  return dir;
}

/** The example instance (nonprod, prod) plus a second build environment "test". */
let instanceCache: string | undefined;
function instance(): string {
  return (instanceCache ??= instanceFile((d) => {
    d.environments.push({ ...d.environments[0], name: "test" } as never);
  }));
}

function inputs(dir: string, envs = ENVS, slug = "demo", inst = instance()) {
  const out = join(tmp(), "release-inputs.json");
  const r = pipe(["release-inputs", "--manifest", join(dir, "platform.yaml"), "--app-dir", dir, "--slug", slug, "--environments", envs, "--instance", inst, "--output", out]);
  return { ...r, out };
}

const minimal = (extra = ""): string => `schemaVersion: "1.0-draft"\napp: demo\n${extra}`;

describe("pipeline release-inputs", () => {
  it("merges environment overrides field by field and resolves defaults", () => {
    const dir = appDir();
    const r = inputs(dir);
    assert.equal(r.code, 0, r.stderr);
    const real = realpathSync(dir);
    assert.deepEqual(readJsonFile(r.out), {
      slug: "demo",
      build: { dockerfile: join(real, "docker", "Dockerfile"), context: real },
      deployBranches: ["main", "release/*", "feat-?"],
      environments: {
        nonprod: {
          runtime: { port: 3000, size: "m", minReplicas: 1, maxReplicas: 4, livenessPath: "/live", readinessPath: "/ready" },
          env: [{ name: "LOG_LEVEL", value: "debug", secret: null }],
          secrets: ["api-key"],
        },
        test: {
          runtime: { port: 3000, size: "m", minReplicas: 1, maxReplicas: 2, livenessPath: "/live", readinessPath: "/live" },
          env: [
            { name: "LOG_LEVEL", value: "info", secret: null },
            { name: "API_KEY", value: null, secret: "api-key" },
          ],
          secrets: ["api-key"],
        },
      },
      warnings: [
        "environment nonprod: delivery.yml carries no capacity reservation (generated before ADR-0053), so the runtime wasn't checked; run `platform generate` in platform-config.",
        "environment test: delivery.yml carries no capacity reservation (generated before ADR-0053), so the runtime wasn't checked; run `platform generate` in platform-config.",
      ],
    });
    assert.match(r.stdout, /^WARNING {2}environment nonprod: delivery\.yml carries no capacity reservation/m);
    assert.match(r.stdout, /^OK {2}release inputs for demo: environments nonprod, test/m);
  });

  describe("capacity reservation (ADR-0053, pipeline check capacity-reservation)", () => {
    // The fixture platform.yaml: nonprod size m, maxReplicas 4; test size m, maxReplicas 2.
    const withCapacity = (nonprod: object, test: object): string =>
      JSON.stringify([
        { name: "nonprod", kind: "nonprod", promoteFrom: "", capacity: nonprod },
        { name: "test", kind: "nonprod", promoteFrom: "", capacity: test },
      ]);
    // releaseInputs itself, with the date injected (the CLI uses today's UTC date).
    const run = (envs: string, today: string) => {
      const dir = appDir();
      try {
        return { inputs: releaseInputs({ manifest: join(dir, "platform.yaml"), appDir: dir, slug: "demo", environments: envs, instance: instance(), today }), problems: [] as string[] };
      } catch (e) {
        if (e instanceof CheckFailed) return { inputs: undefined, problems: e.problems };
        throw e;
      }
    };

    it("passes a runtime within the reservation, without warnings", () => {
      const r = run(withCapacity({ size: "m", maxReplicas: 4 }, { size: "l", maxReplicas: 2 }), "2026-11-11");
      assert.deepEqual(r.problems, []);
      assert.deepEqual(r.inputs?.warnings, []);
    });

    it("warns before enforceFrom about a larger size or more replicas, saying how to ask for more", () => {
      const r = run(withCapacity({ size: "s", maxReplicas: 3 }, { size: "m", maxReplicas: 2 }), "2026-11-11");
      assert.deepEqual(r.problems, []);
      const w = r.inputs!.warnings;
      assert.equal(w.length, 1);
      assert.match(w[0]!, /^platform\.yaml environments\.nonprod in environment nonprod: size m is larger than s and maxReplicas 4 is more than 3, above the app's capacity reservation there \(size s, maxReplicas 3; check capacity-reservation\) \(a warning until 2026-12-11; an error from that date\)\./);
      assert.match(w[0]!, /More capacity/);
    });

    it("fails from enforceFrom on", () => {
      const r = run(withCapacity({ size: "m", maxReplicas: 3 }, { size: "m", maxReplicas: 2 }), "2026-12-11");
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0]!, /^platform\.yaml environments\.nonprod in environment nonprod: maxReplicas 4 is more than 3, above the app's capacity reservation there/);
      assert.doesNotMatch(r.problems[0]!, /a warning until/);
    });

    it("refuses a malformed reservation in the environments parameter", () => {
      const r = inputs(appDir(), withCapacity({ size: "xl", maxReplicas: 3 }, { size: "m", maxReplicas: 0 }));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /--environments\[0\]\.capacity must be \{size: xs\|s\|m\|l, maxReplicas: 1\.\.10\}/);
      assert.match(r.stderr, /--environments\[1\]\.capacity must be/);
    });
  });

  it("applies the schema defaults to a minimal platform.yaml, and raises maxReplicas to minReplicas", () => {
    const r = inputs(appDir(minimal()), ONE_ENV);
    assert.equal(r.code, 0, r.stderr);
    const o = readJsonFile(r.out) as { deployBranches: string[]; environments: Record<string, unknown>; build: { dockerfile: string } };
    assert.deepEqual(o.deployBranches, ["*"]);
    assert.match(o.build.dockerfile, /\/app\/Dockerfile$/);
    assert.deepEqual(o.environments.nonprod, {
      runtime: { port: 8080, size: "s", minReplicas: 0, maxReplicas: 2, livenessPath: "/healthz", readinessPath: "/healthz" },
      env: [],
      secrets: [],
    });
    const raised = inputs(appDir(minimal("runtime:\n  scale:\n    minReplicas: 3\n")), ONE_ENV);
    const rt = (readJsonFile(raised.out) as { environments: { nonprod: { runtime: Record<string, number> } } }).environments.nonprod.runtime;
    assert.equal(rt.minReplicas, 3);
    assert.equal(rt.maxReplicas, 3);
  });

  it("fails when minReplicas exceeds an explicit maxReplicas after merging", () => {
    const r = inputs(appDir(minimal("runtime:\n  scale:\n    maxReplicas: 2\nenvironments:\n  nonprod:\n    scale:\n      minReplicas: 5\n")), ONE_ENV);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /minReplicas \(5\) is greater than maxReplicas \(2\) after merging/);
  });

  it("requires app == slug", () => {
    const slug = inputs(appDir(), ENVS, "other-app");
    assert.equal(slug.code, 1);
    assert.match(slug.stderr, /app "demo" does not match the registered app "other-app"/);
    assert.equal(inputs(appDir(), ENVS, "Bad Slug").code, 1);
    assert.equal(inputs(appDir(), "{oops").code, 1);
    assert.equal(inputs(appDir(), JSON.stringify([{ name: "nonprod", kind: "nonprod" }])).code, 1);
  });

  it("checks override keys against the instance environments; --environments only selects the output", () => {
    // A prod override while the pipeline delivers nonprod only: allowed, prod is not in the output.
    const prod = inputs(appDir(minimal("environments:\n  prod:\n    scale:\n      minReplicas: 1\n")), ONE_ENV);
    assert.equal(prod.code, 0, prod.stderr);
    assert.deepEqual(Object.keys((readJsonFile(prod.out) as { environments: object }).environments), ["nonprod"]);
    // The fixture overrides nonprod; selecting only "test" leaves nonprod out of the output.
    const sel = inputs(appDir(), JSON.stringify([{ name: "test", kind: "nonprod", promoteFrom: "" }]));
    assert.equal(sel.code, 0, sel.stderr);
    assert.deepEqual(Object.keys((readJsonFile(sel.out) as { environments: object }).environments), ["test"]);
    // A typo fails.
    const typo = inputs(appDir(minimal("environments:\n  prdo:\n    size: m\n")), ONE_ENV);
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /environments\.prdo: there is no environment "prdo" on this platform \(environments: nonprod, prod, test\)/);
    // --environments must name instance environments too.
    const unknown = inputs(appDir(minimal()), JSON.stringify([{ name: "qa", kind: "nonprod", promoteFrom: "" }]));
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /--environments: "qa" is not an environment of this instance/);
  });

  it("requires a valid --instance", () => {
    const dir = appDir();
    const out = join(tmp(), "ri.json");
    const missing = pipe(["release-inputs", "--manifest", join(dir, "platform.yaml"), "--app-dir", dir, "--slug", "demo", "--environments", ONE_ENV, "--output", out]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing --instance/);
    const bad = inputs(dir, ONE_ENV, "demo", instanceFile((d) => (d.naming.prefix = "Bad-Prefix")));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /instance\.yaml .*naming\.prefix/);
  });

  it("rejects a platform.yaml that fails the schema or the PC003 consistency rules", () => {
    const schema = inputs(appDir(minimal("bogus: 1\n")), ONE_ENV);
    assert.equal(schema.code, 1);
    assert.match(schema.stderr, /platform\.yaml line 3: bogus: unknown property "bogus"/);
    const pc003 = inputs(appDir(minimal("runtime:\n  env:\n    - name: TOKEN\n      secret: token\n")), ONE_ENV);
    assert.equal(pc003.code, 1);
    assert.match(pc003.stderr, /uses secret "token" that is not listed/);
    const yaml = inputs(appDir("app: [unclosed\n"), ONE_ENV);
    assert.match(yaml.stderr, /YAML syntax error/);
  });

  it("keeps the Dockerfile and build context inside the app directory", () => {
    const outside = inputs(appDir(minimal("build:\n  dockerfile: ../outside/Dockerfile\n")), ONE_ENV);
    assert.equal(outside.code, 1);
    const abs = inputs(appDir(minimal("build:\n  dockerfile: /etc/passwd\n")), ONE_ENV);
    assert.match(abs.stderr, /must be a relative path/);
    const missingCtx = inputs(appDir(minimal("build:\n  context: nope\n")), ONE_ENV);
    assert.match(missingCtx.stderr, /build\.context "nope" does not exist/);
    const ctxFile = inputs(appDir(minimal("build:\n  context: Dockerfile\n")), ONE_ENV);
    assert.match(ctxFile.stderr, /is not a directory/);

    // A symlink inside the repo pointing outside it is followed and rejected.
    const dir = appDir(minimal("build:\n  dockerfile: link/Dockerfile\n"));
    const elsewhere = tmp("pc-elsewhere-");
    write(elsewhere, "Dockerfile", "FROM scratch\n");
    symlinkSync(elsewhere, join(dir, "link"));
    const link = inputs(dir, ONE_ENV);
    assert.equal(link.code, 1);
    assert.match(link.stderr, /resolves outside the app directory/);
  });

  it("refuses a platform.yaml that is a symlink or too large", () => {
    const dir = appDir();
    const target = join(tmp(), "real.yaml");
    copyFileSync(join(PIPE, "platform.yaml"), target);
    const linked = join(tmp("pc-app-"), "app");
    mkdirSync(linked);
    writeFileSync(join(linked, "Dockerfile"), "FROM scratch\n");
    symlinkSync(target, join(linked, "platform.yaml"));
    const r = inputs(linked);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /platform\.yaml is a symbolic link/);
    writeFileSync(join(dir, "platform.yaml"), minimal("# " + "x".repeat(1024 * 1024) + "\n"));
    assert.match(inputs(dir, ONE_ENV).stderr, /more than the limit/);
  });

  it("neutralises file content echoed in errors", () => {
    const r = inputs(appDir(minimal(`"${VSO}task.setvariable variable=x]1": true\n`)), ONE_ENV);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes(VSO), r.stderr);
  });
});

describe("pipeline promote-branch", () => {
  function promote(ref: string | undefined, def = "refs/heads/main", extra: string[] = []) {
    return pipe(["promote-branch", "--default-branch", def, ...extra], ref === undefined ? {} : { RESOURCES_REPOSITORIES_APP_REF: ref });
  }

  it("is true only for the default branch itself", () => {
    const cases: [string, string, string][] = [
      ["refs/heads/main", "refs/heads/main", "true"],
      ["refs/heads/release/1", "refs/heads/release/1", "true"],
      ["refs/heads/main2", "refs/heads/main", "false"],
      ["refs/heads/feature/main", "refs/heads/main", "false"],
      ["refs/tags/main", "refs/heads/main", "false"],
      ["refs/heads/Main", "refs/heads/main", "false"],
    ];
    for (const [ref, def, want] of cases) {
      const r = promote(ref, def);
      assert.equal(r.code, 0, `${ref}: ${r.stderr}`);
      assert.equal(r.stdout, `${want}\n`, `${ref} vs ${def}`);
    }
  });

  it("sets the output variable with --set-output", () => {
    const r = promote("refs/heads/main", "refs/heads/main", ["--set-output", "promote"]);
    assert.equal(r.stdout, `true\n${VSO}task.setvariable variable=promote;isoutput=true]true\n`);
    const no = promote("refs/heads/dev", "refs/heads/main", ["--set-output", "promote"]);
    assert.equal(no.stdout, `false\n${VSO}task.setvariable variable=promote;isoutput=true]false\n`);
    assert.equal(promote("refs/heads/main", "refs/heads/main", ["--set-output", "a]b"]).code, 2);
  });

  it("fails on an invalid --default-branch or an unset ref", () => {
    for (const def of ["main", "refs/heads/", "refs/tags/v1", "refs/heads/a b"]) {
      const r = promote("refs/heads/main", def);
      assert.equal(r.code, 1, def);
      assert.equal(r.stdout, "");
    }
    assert.equal(promote(undefined).code, 1);
    assert.equal(pipe(["promote-branch"]).code, 2);
  });
});

describe("pipeline deploy-branch", () => {
  const manifest = join(PIPE, "platform.yaml"); // branches: main, release/*, feat-?

  function decide(ref: string, file = manifest, extra: string[] = []) {
    return pipe(["deploy-branch", "--manifest", file, ...extra], { RESOURCES_REPOSITORIES_APP_REF: ref });
  }

  it("matches deploy.branches globs against the full branch name", () => {
    const cases: [string, string][] = [
      ["refs/heads/main", "true"],
      ["refs/heads/release/2026.10", "true"],
      ["refs/heads/release/a/b", "true"],
      ["refs/heads/feat-x", "true"],
      ["refs/heads/feat-xy", "false"],
      ["refs/heads/mainline", "false"],
      ["refs/heads/xmain", "false"],
      ["refs/tags/main", "false"],
      ["refs/pull/1/merge", "false"],
      ["refs/heads/", "false"],
    ];
    for (const [ref, want] of cases) {
      const r = decide(ref);
      assert.equal(r.code, 0, `${ref}: ${r.stderr}`);
      assert.equal(r.stdout, `${want}\n`, ref);
    }
  });

  it("defaults to all branches", () => {
    const file = join(tmp(), "platform.yaml");
    writeFileSync(file, minimal());
    assert.equal(decide("refs/heads/any/deep/branch", file).stdout, "true\n");
  });

  it("treats regex characters literally", () => {
    assert.equal(branchMatches(["a.b"], "a.b"), true);
    assert.equal(branchMatches(["a.b"], "axb"), false);
    assert.equal(branchMatches(["fix(1)+[x]"], "fix(1)+[x]"), true);
    assert.equal(branchMatches(["*"], ""), true);
    assert.equal(branchMatches(["r?"], "r/"), true);
  });

  it("sets the output variable with --set-output (the only logging command)", () => {
    const r = decide("refs/heads/main", manifest, ["--set-output", "deployBuildEnvironments"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `true\n${VSO}task.setvariable variable=deployBuildEnvironments;isoutput=true]true\n`);
    const no = decide("refs/heads/other", manifest, ["--set-output", "deployBuildEnvironments"]);
    assert.equal(no.stdout, `false\n${VSO}task.setvariable variable=deployBuildEnvironments;isoutput=true]false\n`);
    assert.equal(decide("refs/heads/main", manifest, ["--set-output", "x;isoutput=false]"]).code, 2);
  });

  it("fails when the ref is not set or platform.yaml is invalid", () => {
    assert.equal(pipe(["deploy-branch", "--manifest", manifest]).code, 1);
    const file = join(tmp(), "platform.yaml");
    writeFileSync(file, minimal("deploy:\n  branches: []\n"));
    const r = decide("refs/heads/main", file);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
  });
});
