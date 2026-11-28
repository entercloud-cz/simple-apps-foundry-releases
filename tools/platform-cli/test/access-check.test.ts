import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { checkAccess } from "../src/checks/access.js";
import { Context } from "../src/context.js";
import { tmp } from "./helpers.js";

// platform check, group access (ADR-0078): the default access policy, its contract test, role levels and the user menu.

function repo(files: Record<string, string>): string {
  const dir = tmp("pc-access-");
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const ROLES = JSON.stringify({ signIn: true, roles: [{ value: "Reader", displayName: "Reader", level: "read" }, { value: "Editor", displayName: "Editor", level: "write" }] });
const ids = (dir: string): string[] => {
  const r = checkAccess(new Context({ dir } as never));
  return r.findings.map((f) => f.ruleId).sort();
};

describe("platform check: access (ADR-0078)", () => {
  it("a repository without .platform/roles.json (before the agent files update): skipped", () => {
    const r = checkAccess(new Context({ dir: repo({ "src/x.ts": "" }) } as never));
    assert.equal(r.findings.length, 0);
    assert.match(r.skipped?.reason ?? "", /platform agent-files update/);
  });

  it("the starter's policy, its test and the user menu: nothing to report", () => {
    const dir = repo({
      ".platform/roles.json": ROLES,
      "src/server/auth/policy.ts": "// saf:access-policy\nexport const x = 1;\n",
      "test/access.test.ts": "// saf:access-contract-test\nit('works', () => {});\n",
      "src/client/UserMenu.tsx": "<a href=\"/.auth/logout?post_logout_redirect_uri=/\">Sign out</a>",
    });
    assert.deepEqual(ids(dir), []);
  });

  it("no policy, no test, no sign-out: PC066 twice and PC068; a skipped test is PC066 too", () => {
    assert.deepEqual(ids(repo({ ".platform/roles.json": ROLES, "src/app.ts": "export {};\n" })), ["PC066", "PC066", "PC068"]);
    const skipped = repo({
      ".platform/roles.json": ROLES,
      "src/policy.py": "# saf:access-policy\n",
      "tests/test_access.py": "# saf:access-contract-test\n@pytest.mark.skip\ndef test_x(): pass\n",
      "templates/base.html": "<a href=\"/.auth/logout\">Sign out</a>",
    });
    assert.deepEqual(ids(skipped), ["PC066"]);
    // Build output and dependencies don't count.
    assert.deepEqual(ids(repo({ ".platform/roles.json": ROLES, "node_modules/x/policy.js": "// saf:access-policy", "dist/t.js": "// saf:access-contract-test", "src/a.ts": "'/.auth/logout'" })), ["PC066", "PC066"]);
  });

  it("a role without a level is PC067; a public app checks nothing; an unreadable file is PC067", () => {
    const dir = repo({
      ".platform/roles.json": JSON.stringify({ signIn: true, roles: [{ value: "Reader", level: "read" }, { value: "Approver" }] }),
      "Program.cs": "// saf:access-policy\n",
      "Tests/AccessTests.cs": "// saf:access-contract-test\n[Fact] public void X() {}\n",
      "Pages/Shared/_Layout.cshtml": "<a href=\"/.auth/logout\">Sign out</a>",
    });
    assert.deepEqual(ids(dir), ["PC067"]);
    assert.deepEqual(ids(repo({ ".platform/roles.json": JSON.stringify({ signIn: false, roles: [] }), "src/a.ts": "" })), []);
    assert.deepEqual(ids(repo({ ".platform/roles.json": "not json" })), ["PC067"]);
  });
});
