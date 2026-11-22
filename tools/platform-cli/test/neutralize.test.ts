import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, copyFixture, fakeBin, tmp, write } from "./helpers.js";
import { FMT, VSO } from "./pipeline-helpers.js";
import { neutralize } from "../src/neutralize.js";

const ZWSP = "​";

describe("neutralize (Azure DevOps logging commands)", () => {
  it("breaks ##vso[ and ##[ anywhere in a line, case-insensitively", () => {
    assert.equal(neutralize(`${VSO}task.setvariable variable=a]1`), `#${ZWSP}#vso[task.setvariable variable=a]1`);
    assert.equal(neutralize(`x ${FMT}group]y`), `x #${ZWSP}#[group]y`);
    assert.equal(neutralize("##VSO[task.complete]"), `#${ZWSP}#VSO[task.complete]`);
    assert.equal(neutralize("###vso[x]"), `##${ZWSP}#vso[x]`);
    assert.equal(neutralize("# vso[ ## plain #[x]"), "# vso[ ## plain #[x]");
    for (const s of [`${VSO}a]`, `#${VSO}a]`, `${FMT}${FMT}`, `a${VSO}${VSO}b`]) {
      assert.ok(!/##(vso\[|\[)/i.test(neutralize(s)), s);
    }
  });

  // Fake docker whose build output and container logs carry logging commands.
  const FAKE_DOCKER = `#!/usr/bin/env node
const a = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE;
const evil = "#" + "#vso[task.setvariable variable=pwned]1\\n" + "#" + "#[group]fake\\n" + "#" + "#VSO[task.complete result=Succeeded]done";
switch (a[0]) {
  case "version": console.log("27.0.0"); break;
  case "build": if (mode === "build-fail") { console.error(evil); process.exit(1); } break;
  case "run": console.log("abc"); break;
  case "port": console.log("127.0.0.1:1"); break;
  case "inspect": console.log("false 3"); break;
  case "logs": console.log(evil); break;
  default: break;
}
`;

  for (const mode of ["build-fail", "exited"]) {
    it(`platform check prints no logging command from docker output (${mode}), in text, json and sarif`, () => {
      const dir = copyFixture("good-app");
      const bin = fakeBin("docker", FAKE_DOCKER);
      const env = { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_DOCKER_MODE: mode };
      const text = cli(["check", dir, "--only", "runtime", "--smoke-timeout", "2"], env);
      assert.equal(text.code, 1);
      assert.match(text.stdout, /PC06[15]/);
      assert.match(text.stdout, /setvariable variable=pwned/, "the text is still shown, only neutralised");
      assert.ok(!/##(vso\[|\[)/i.test(text.stdout + text.stderr), text.stdout);
      for (const format of ["json", "sarif"]) {
        const out = join(tmp(), `report.${format}`);
        const r = cli(["check", dir, "--only", "runtime", "--smoke-timeout", "2", "--format", format, "--output", out], env);
        assert.equal(r.code, 1);
        const content = readFileSync(out, "utf8");
        JSON.parse(content);
        assert.ok(!/##(vso\[|\[)/i.test(content + r.stdout), format);
      }
    });
  }

  it("platform check neutralises repo content echoed in findings (schema errors, paths)", () => {
    const dir = copyFixture("good-app");
    write(dir, "platform.yaml", `schemaVersion: "1.0-draft"\napp: demo-app\n"${VSO}task.setvariable variable=x]1": 1\n`);
    const r = cli(["check", dir, "--only", "manifest"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unknown property/);
    assert.ok(!r.stdout.includes(VSO), r.stdout);
  });
});
