import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, cli, copyFixture, errorIds, FIXTURES, REPO_ROOT, tmp, write } from "./helpers.js";
import { validateFile } from "../src/validate.js";

describe("validate (schema)", () => {
  it("accepts the example instance configuration", () => {
    const r = validateFile("instance", join(REPO_ROOT, "config", "examples", "instance.example.yaml"));
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it("accepts the good fixture manifest", () => {
    assert.equal(validateFile("manifest", join(FIXTURES, "good-app", "platform.yaml")).ok, true);
  });

  it("reports readable problems with line numbers and collapses oneOf noise", () => {
    const dir = tmp();
    write(
      dir,
      "m.yaml",
      [
        'schemaVersion: "1.0-draft"',
        "app: Platform",
        "bogus: 1",
        "runtime:",
        "  port: 80",
        "  env:",
        "    - name: PORT",
        "      value: x",
        "    - name: FOO",
        "secrets: [a, a]",
        "",
      ].join("\n"),
    );
    const r = validateFile("manifest", join(dir, "m.yaml"));
    assert.equal(r.ok, false);
    const byPath = Object.fromEntries(r.problems.map((p) => [p.path, p]));
    assert.equal(byPath["app"]?.line, 2);
    assert.equal(byPath["bogus"]?.line, 3);
    assert.match(byPath["bogus"]?.message ?? "", /unknown property/);
    assert.equal(byPath["runtime.port"]?.line, 5);
    assert.match(byPath["runtime.env[0].name"]?.help ?? "", /injected by the platform/);
    assert.match(byPath["runtime.env[1]"]?.message ?? "", /missing required property "value"/);
    assert.match(byPath["secrets"]?.message ?? "", /duplicate/);
    // oneOf noise must be gone: no raw "must match exactly one schema" message
    assert.ok(!r.problems.some((p) => /oneOf/.test(p.message)));
  });

  it("rejects every platform-injected variable name in runtime.env", () => {
    const names = [
      "PORT",
      "AZURE_CLIENT_ID",
      "APPLICATIONINSIGHTS_CONNECTION_STRING",
      "CONTAINER_APP_NAME",
      "DATABASE_HOST",
      "DATABASE_NAME",
      "DATABASE_USER",
      "STORAGE_BLOB_ENDPOINT",
      "FRONT_DOOR_ID",
    ];
    const dir = tmp();
    write(dir, "m.yaml", ['schemaVersion: "1.0-draft"', "app: demo-app", "runtime:", "  env:", ...names.flatMap((n) => [`    - name: ${n}`, "      value: x"]), ""].join("\n"));
    const r = validateFile("manifest", join(dir, "m.yaml"));
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.problems.filter((p) => /injected by the platform/.test(p.help ?? "")).map((p) => p.path).sort(),
      names.map((_, i) => `runtime.env[${i}].name`).sort(),
    );
    write(dir, "ok.yaml", ['schemaVersion: "1.0-draft"', "app: demo-app", "runtime:", "  env:", "    - name: DATABASE_PASSWORD_HINT", "      value: x", ""].join("\n"));
    assert.equal(validateFile("manifest", join(dir, "ok.yaml")).ok, true);
  });

  it("reports YAML syntax errors", () => {
    const dir = tmp();
    write(dir, "m.yaml", "app: [unclosed\n");
    const r = validateFile("manifest", join(dir, "m.yaml"));
    assert.equal(r.ok, false);
    assert.ok(r.parseErrors.length > 0);
  });

  it("rejects an instance missing required keys", () => {
    const dir = tmp();
    write(dir, "i.yaml", 'schemaVersion: "1.0-draft"\n');
    const r = validateFile("instance", join(dir, "i.yaml"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /missing required property "tenantId"/.test(p.message)));
  });

  it("portal.clientId, apiBaseUrl and identityPrincipalId: optional, checked formats with a readable hint", async () => {
    const { parse, stringify } = await import("yaml");
    const example = parse(readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const dir = tmp();
    const validateWith = (portal: Record<string, unknown>) => {
      write(dir, "i.yaml", stringify({ ...example, portal: { ...example.portal, ...portal } }));
      return validateFile("instance", join(dir, "i.yaml"));
    };
    const { clientId: _c, apiBaseUrl: _a, identityPrincipalId: _p, ...without } = example.portal;
    write(dir, "none.yaml", stringify({ ...example, portal: without }));
    assert.deepEqual(validateFile("instance", join(dir, "none.yaml")).problems, [], "all three are optional");
    for (const ok of ["https://portal.contoso.com", "https://ca-contoso-portal.blue-sea-1234.westeurope.azurecontainerapps.io", "https://portal.contoso.com:8443"]) {
      assert.deepEqual(validateWith({ apiBaseUrl: ok }).problems, [], ok);
    }
    for (const bad of ["http://portal.contoso.com", "https://portal.contoso.com/", "https://portal.contoso.com/api", "https://portal.contoso.com?x=1", "https://portal.contoso.com#x", "https://user@portal.contoso.com", "https://Portal.Contoso.com", "https://portal", "portal.contoso.com", "https://portal.contoso.com:0"]) {
      const r = validateWith({ apiBaseUrl: bad });
      assert.equal(r.ok, false, bad);
      const p = r.problems.find((x) => x.path === "portal.apiBaseUrl");
      assert.match(p?.message ?? "", /invalid format/, bad);
      assert.match(p?.help ?? "", /^Optional\. https:\/\/<host>\[:port\] with no path, query, fragment or trailing slash/, bad);
      assert.ok(p?.line, "with a line number");
    }
    for (const key of ["clientId", "identityPrincipalId"]) {
      const r = validateWith({ [key]: "id-contoso-portal" });
      const p = r.problems.find((x) => x.path === `portal.${key}`);
      assert.match(p?.message ?? "", /invalid format/, key);
      assert.match(p?.help ?? "", /^Optional\. A GUID: the (client \(application\)|principal \(object\)) ID/, key);
    }
    assert.match(validateWith({ apiUrl: "https://portal.contoso.com" }).problems.map((p) => p.message).join(), /unknown property "apiUrl"/);
  });

  it("data.backup retention: 7-35 days for both kinds (PostgreSQL's minimum), with the reason as hint", async () => {
    const { parse, stringify } = await import("yaml");
    const example = parse(readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const dir = tmp();
    const validateWith = (backup: Record<string, unknown>) => {
      write(dir, "i.yaml", stringify({ ...example, data: { ...example.data, backup: { ...example.data.backup, ...backup } } }));
      return validateFile("instance", join(dir, "i.yaml"));
    };
    assert.deepEqual(validateWith({ retentionDaysNonprod: 7, retentionDaysProd: 7 }).problems, []);
    assert.deepEqual(validateWith({ retentionDaysNonprod: 35 }).problems, []);
    for (const [key, value, message] of [["retentionDaysNonprod", 1, /must be >= 7/], ["retentionDaysNonprod", 6, /must be >= 7/], ["retentionDaysProd", 6, /must be >= 7/], ["retentionDaysNonprod", 36, /must be <= 35/]] as const) {
      const p = validateWith({ [key]: value }).problems.find((x) => x.path === `data.backup.${key}`);
      assert.match(p?.message ?? "", message, `${key} ${value}`);
      assert.match(p?.help ?? "", /^7-35 days, because PostgreSQL Flexible Server accepts no less than 7/, `${key} ${value}`);
    }
  });

  it("CLI: exit codes 0 / 1 / 2", () => {
    assert.equal(cli(["validate", "instance", join(REPO_ROOT, "config", "examples", "instance.example.yaml")]).code, 0);
    const dir = tmp();
    write(dir, "m.yaml", "app: x\n");
    const bad = cli(["validate", "manifest", join(dir, "m.yaml")]);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /FAILED/);
    assert.equal(cli(["validate", "manifest", join(dir, "nope.yaml")]).code, 2);
    assert.equal(cli(["validate", "other", "x"]).code, 2);
  });
});

describe("platform.yaml check", () => {
  it("passes for the good fixture", async () => {
    const r = await check(copyFixture("good-app"), { only: ["manifest"] });
    assert.deepEqual(r.findings, []);
  });

  it("PC001 when platform.yaml is missing", async () => {
    const dir = copyFixture("good-app");
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "platform.yaml"));
    const r = await check(dir, { only: ["manifest"] });
    assert.deepEqual(errorIds(r), ["PC001"]);
  });

  it("PC001 for invalid YAML, PC002 for schema errors", async () => {
    const dir = copyFixture("good-app");
    write(dir, "platform.yaml", "app: [oops\n");
    assert.deepEqual(errorIds(await check(dir, { only: ["manifest"] })), ["PC001"]);
    write(dir, "platform.yaml", 'schemaVersion: "1.0-draft"\napp: Bad_App\n');
    const r = await check(dir, { only: ["manifest"] });
    assert.deepEqual(errorIds(r), ["PC002"]);
    assert.equal(r.findings[0]?.line, 2);
    assert.ok(r.findings[0]?.hint && r.findings[0].aiPrompt);
  });

  it("PC003 semantic problems", async () => {
    const dir = copyFixture("good-app");
    write(
      dir,
      "platform.yaml",
      [
        'schemaVersion: "1.0-draft"',
        "app: my-microsoft-app",
        "runtime:",
        "  scale: { minReplicas: 3, maxReplicas: 1 }",
        "  env:",
        "    - { name: A, secret: undeclared }",
        "    - { name: B, value: x }",
        "    - { name: B, value: y }",
        "secrets: []",
        "",
      ].join("\n"),
    );
    const r = await check(dir, { only: ["manifest"] });
    const msgs = r.findings.map((f) => f.message).join("\n");
    assert.deepEqual([...new Set(errorIds(r))], ["PC003"]);
    assert.match(msgs, /reserved word/);
    assert.match(msgs, /minReplicas \(3\) is greater than maxReplicas \(1\)/);
    assert.match(msgs, /secret "undeclared" that is not listed/);
    assert.match(msgs, /defined twice/);
  });

  it("checks secrets referenced in environment overrides", async () => {
    const dir = copyFixture("good-app");
    write(
      dir,
      "platform.yaml",
      'schemaVersion: "1.0-draft"\napp: demo-app\nenvironments:\n  prod:\n    env:\n      - { name: X, secret: not-declared }\n',
    );
    const r = await check(dir, { only: ["manifest"] });
    assert.match(r.findings[0]?.message ?? "", /environments\.prod\.env\[0\]/);
  });
});
