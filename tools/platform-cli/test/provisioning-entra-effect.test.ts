import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { cli, REPO_ROOT, tmp } from "./helpers.js";
import { entraEffect, entraSide, formatEntraEffect } from "../src/provisioning/entra-effect.js";

// `platform provisioning entra-effect` (ADR-0051): what a change of app.yaml does in Entra.
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const EXAMPLE = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const base = parse(readFileSync(EXAMPLE, "utf8")) as J;
const G1 = "00000000-0000-0000-0000-00000000a0a1";
const G2 = "00000000-0000-0000-0000-00000000a0a2";

function app(change: (d: J) => void): J {
  const d = structuredClone(base);
  change(d);
  return d;
}

const signedIn = app((d) => {
  d.authentication = { mode: "required", roles: [{ value: "Reader", displayName: "Reader" }], assignments: [{ role: "Reader", principalType: "Group", objectId: G1, displayName: "sg-staff" }] };
});

describe("entraEffect", () => {
  it("role assignments and app roles added and removed; nothing else changes", () => {
    const head = app((d) => {
      d.authentication = {
        mode: "required",
        roles: [
          { value: "Reader", displayName: "Reader" },
          { value: "Auditor", displayName: "Auditor" },
        ],
        assignments: [{ role: "Auditor", principalType: "User", objectId: G2.toUpperCase(), displayName: "Jana" }],
      };
    });
    const e = entraEffect(entraSide(signedIn, "base"), entraSide(head, "head"), "pullRequest");
    assert.equal(e.changes, true);
    assert.deepEqual(e.assignments, { added: [{ role: "Auditor", principalType: "User", objectId: G2, displayName: "Jana" }], removed: [{ role: "Reader", principalType: "Group", objectId: G1, displayName: "sg-staff" }] });
    assert.deepEqual(e.roles, { added: ["Auditor"], removed: [] });
    assert.deepEqual(e.environments, { added: [], removed: [] });
    assert.equal(
      formatEntraEffect(e),
      `Entra effect of apps/${base.slug}/app.yaml (approvals.entraChanges: pullRequest: merging this pull request applies it without a further approval):\n` +
        `  + role Auditor: user Jana (${G2})\n` +
        `  - role Reader: group sg-staff (${G1})\n` +
        "  + app role Auditor\n",
    );
    assert.equal(formatEntraEffect(entraEffect(entraSide(signedIn, "b"), entraSide(signedIn, "h"))), `Entra effect of apps/${base.slug}/app.yaml: no Entra change.\n`);
  });

  it("sign-in turned on, a new app, an environment added, a custom host: registrations and redirect URIs", () => {
    const anonymous = app((d) => (d.authentication = { mode: "anonymous" }));
    const on = entraEffect(entraSide(anonymous, "b"), entraSide(signedIn, "h"));
    assert.deepEqual([on.signIn, on.environments.added, on.assignments.added.length], [{ before: false, after: true }, Object.keys(base.environments).sort(), 1]);
    assert.match(formatEntraEffect(on), /sign-in turned on: a registration in /);
    // Anonymous on both sides: nothing in Entra, whatever else changes.
    assert.equal(entraEffect(entraSide(anonymous, "b"), entraSide(app((d) => ((d.authentication = { mode: "anonymous" }), (d.title = "X"))), "h")).changes, false);
    const env = Object.keys(base.environments)[0]!;
    const hosted = app((d) => {
      d.authentication = signedIn.authentication;
      d.environments[env].frontDoor = { hostName: "Inventory.Contoso.com" };
    });
    const host = entraEffect(entraSide(signedIn, "b"), entraSide(hosted, "h"), "separate");
    assert.deepEqual(host.hosts, [{ environment: env, after: "inventory.contoso.com" }]);
    assert.match(formatEntraEffect(host), new RegExp(`waits for its own approval after the merge\\):\\n  redirect URI in ${env}: the default host -> inventory\\.contoso\\.com\\n$`));
  });
});

describe("platform provisioning entra-effect", () => {
  it("reads two files (or none for a new app), adds the instance's mode, writes JSON", () => {
    const dir = tmp("pc-entra-effect-");
    const head = join(dir, "head.yaml");
    writeFileSync(head, stringify(signedIn));
    const out = join(dir, "effect.json");
    const r = cli(["provisioning", "entra-effect", "--base", "none", "--head", head, "--instance", INSTANCE, "--output", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\(approvals\.entraChanges: pullRequest: merging this pull request applies it without a further approval\):\n {2}sign-in turned on/);
    const json = JSON.parse(readFileSync(out, "utf8")) as J;
    assert.equal(json.entraChanges, "pullRequest");
    assert.equal(json.changes, true);
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "a: [\n");
    const e = cli(["provisioning", "entra-effect", "--base", bad, "--head", head]);
    assert.equal(e.code, 1);
    assert.match(e.stderr, /--base line \d+:/);
    assert.equal(cli(["provisioning", "entra-effect", "--head", head]).code, 2);
  });
});
