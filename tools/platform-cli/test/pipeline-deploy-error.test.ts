import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers.js";
import { PIPE, pipe } from "./pipeline-helpers.js";
import { classify, errorRecords } from "../src/pipeline/deploy-error.js";

// Log fixtures: test/fixtures/pipeline/deploy-errors/{retry,fail}-*.log. Codes and messages follow
// the sources cited in src/pipeline/deploy-error.ts; the exact envelopes (az JSON vs. az text,
// BadRequest wrapping a JSON string) are representative. TODO(verify): capture real logs from the
// sandbox (fresh runtime identity, just-pushed digest) and replace these fixtures.
const DIR = join(PIPE, "deploy-errors");

describe("pipeline classify-deploy-error", () => {
  const logs = readdirSync(DIR).filter((f) => f.endsWith(".log"));

  it("has fixtures for both outcomes", () => {
    assert.ok(logs.filter((f) => f.startsWith("retry-")).length >= 4);
    assert.ok(logs.filter((f) => f.startsWith("fail-")).length >= 4);
  });

  for (const f of logs) {
    const want = f.startsWith("retry-") ? "retry" : "fail";
    it(`${f} -> ${want}`, () => {
      const r = pipe(["classify-deploy-error", "--log", join(DIR, f)]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `${want}\n`);
      assert.equal(r.stderr, "");
    });
  }

  it("reads az JSON and az text errors, and unwraps JSON-in-message errors", () => {
    const codes = (t: string): string[] => errorRecords(t).map((r) => r.code);
    assert.deepEqual(codes('ERROR: {"error":{"code":"DeploymentFailed","details":[{"code":"PrincipalNotFound","message":"m"}]}}'), ["DeploymentFailed", "PrincipalNotFound"]);
    assert.deepEqual(codes("ERROR: (DeploymentFailed) x\nCode: DeploymentFailed\nMessage: x\n"), ["DeploymentFailed", "DeploymentFailed"]);
    assert.deepEqual(codes('{"code":"BadRequest","message":"{\\"code\\":\\"PrincipalNotFound\\",\\"message\\":\\"m\\"}"}'), ["PrincipalNotFound"]);
  });

  it("is specific: the right code AND an image pull refusal are both needed", () => {
    const pull = (code: string, msg: string): string => JSON.stringify({ error: { code: "DeploymentFailed", details: [{ code, message: msg }] } });
    assert.equal(classify(pull("ContainerAppOperationError", "Field 'template.containers.demo.image' ... UNAUTHORIZED: authentication required")), "retry");
    assert.equal(classify(pull("ContainerAppOperationError", "Field 'template.containers.demo.image' ... DENIED: requested access to the resource is denied")), "retry");
    assert.equal(classify(pull("ContainerAppOperationError", "Failed to provision revision: Operation expired.")), "fail");
    assert.equal(classify(pull("InvalidTemplate", "image ... UNAUTHORIZED")), "fail");
    assert.equal(classify(pull("ContainerAppOperationError", "secret reference unauthorized")), "fail");
    assert.equal(classify(pull("AuthorizationFailed", "The client does not have authorization")), "fail");
    assert.equal(classify(""), "fail");
    assert.equal(classify("DeploymentFailed"), "fail");
  });

  it("only looks at the tail of a huge log and stays fast on brace noise", () => {
    const file = join(tmp(), "big.log");
    const noise = "{".repeat(200_000) + "\n";
    writeFileSync(file, noise.repeat(8) + 'ERROR: {"error":{"code":"PrincipalNotFound","message":"replication"}}\n');
    const t0 = Date.now();
    const r = pipe(["classify-deploy-error", "--log", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 15_000);
    assert.match(r.stdout, /^(retry|fail)\n$/);
  });

  it("fails (exit 1) when the log cannot be read, and is a usage error without --log", () => {
    const r = pipe(["classify-deploy-error", "--log", join(tmp(), "missing.log")]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.equal(pipe(["classify-deploy-error"]).code, 2);
  });
});
