import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tmp } from "./helpers.js";
import { cmdApp } from "../src/portal/app-roles.js";
import type { PortalSession } from "../src/portal/session.js";
import { BUILT_IN_ROLE_DESCRIPTIONS, defaultRoleDescription, describedRoles } from "../src/roles.js";
import { appRolesText, rolesText } from "../src/repo/render.js";
import { parseAgentsMd } from "../src/repo/agent-files.js";
import { groupDescription } from "../src/provisioning/app-groups.js";

// What each app role may do (product owner, 2026-11-28): the core's default descriptions, the Roles row of AGENTS.md
// and `platform app roles`.

// Never the user's own sign-in on this computer.
process.env.SAF_CONFIG_DIR = tmp("pc-app-roles-config-");

const session: PortalSession = {
  portal: "https://portal.contoso.com",
  tenantId: "00000000-0000-0000-0000-000000000001",
  clientId: "00000000-0000-0000-0000-00000000e201",
  scope: "api://00000000-0000-0000-0000-00000000e101/apps.read",
};

function repo(): string {
  const dir = tmp("pc-app-roles-");
  writeFileSync(join(dir, "platform.yaml"), "app: hotel-inventory\n");
  mkdirSync(join(dir, ".platform"), { recursive: true });
  return dir;
}

function portalWith(body: unknown, status = 200): typeof fetch {
  return (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://portal.contoso.com/api/apps/hotel-inventory");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function run(args: string[], fetchFn: typeof fetch, s: PortalSession | null = session): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await cmdApp(args, { fetchFn, ...(s ? { session: s } : {}), token: async () => "token", autoSignIn: async () => "no browser here", out: (x) => (out += x), err: (x) => (err += x) });
  return { code, out, err };
}

describe("app roles: what each role may do", () => {
  it("the core describes its default roles; the instance's text wins; others have none", () => {
    assert.equal(defaultRoleDescription("Reader"), BUILT_IN_ROLE_DESCRIPTIONS.Reader);
    assert.equal(defaultRoleDescription("Reader", { Reader: "Sees the stock levels." }), "Sees the stock levels.");
    assert.equal(defaultRoleDescription("Auditor"), undefined);
    assert.deepEqual(describedRoles(undefined, ["Reader", "Auditor"], { Auditor: "Reads the audit trail." }), [
      { value: "Reader", displayName: "Reader", description: BUILT_IN_ROLE_DESCRIPTIONS.Reader },
      { value: "Auditor", displayName: "Auditor", description: "Reads the audit trail." },
    ]);
    // An app's own roles keep their own description (or none): never the defaults'.
    assert.deepEqual(describedRoles([{ value: "Reader", displayName: "Viewer" }], ["Reader"]), [{ value: "Reader", displayName: "Viewer" }]);
  });

  it("the Roles row of AGENTS.md: one line, safe for the table, read back by the update", () => {
    assert.equal(rolesText([{ value: "Reader", description: "Sees | <all> `stock`\nlevels." }, { value: "Admin" }]), "Reader: Sees all stock levels.; Admin: no description yet");
    const inst = { authentication: { defaultAppRoles: ["Reader", "Editor"] } } as never;
    assert.equal(appRolesText({ authentication: { mode: "required" } } as never, inst), `Reader: ${BUILT_IN_ROLE_DESCRIPTIONS.Reader}; Editor: ${BUILT_IN_ROLE_DESCRIPTIONS.Editor}`);
    assert.equal(appRolesText({ authentication: { mode: "anonymous" } } as never, inst), "none: the app is public, without sign-in");
    const facts = parseAgentsMd("| Roles | Reader: Sees it.; Admin: Does all. (as of the last agent-files update; `platform app roles` prints the current ones) |\n");
    assert.equal(facts.roles, "Reader: Sees it.; Admin: Does all.");
  });

  it("an app group's description says what the role may do", () => {
    assert.equal(groupDescription("nonprod", "Hotel Inventory", "Reader", "Sees the stock levels"), "Non-production users of Hotel Inventory with the role Reader. Sees the stock levels. Its owners manage the members in the portal.");
    assert.equal(groupDescription("prod", "Hotel Inventory", "Admin", undefined), "Production users of Hotel Inventory with the role Admin. Its owners manage the members in the portal.");
  });

  it("platform app roles prints the portal's roles; --json for a script", async () => {
    const body = { authentication: { mode: "required", roles: [{ value: "Reader", displayName: "Reader", description: "Can see it." }, { value: "Approver", displayName: "Approver" }] } };
    const dir = repo();
    const text = await run(["roles", "--dir", dir], portalWith(body));
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, "Reader    Can see it.\nApprover  no description yet: ask the owner to describe it in the portal\n");
    const json = await run(["roles", "--dir", dir, "--json"], portalWith(body));
    assert.deepEqual(JSON.parse(json.out), { app: "hotel-inventory", signIn: true, roles: [{ value: "Reader", displayName: "Reader", description: "Can see it." }, { value: "Approver", displayName: "Approver" }] });
    const pub = await run(["roles", "--dir", dir], portalWith({ authentication: { mode: "anonymous" } }));
    assert.equal(pub.out, "hotel-inventory is public: no sign-in, no roles.\n");
  });

  it("platform app roles: the portal's refusal is exit 1, no sign-in exit 2", async () => {
    const dir = repo();
    const refused = await run(["roles", "--dir", dir], portalWith({}, 404));
    assert.equal(refused.code, 1);
    assert.match(refused.err, /HTTP 404/);
    const none = await run(["roles", "--dir", dir, "--no-login"], portalWith({}), null);
    assert.equal(none.code, 2);
    assert.match(none.err, /not signed in to the portal/);
    await assert.rejects(cmdApp(["users"]), /Usage: platform app roles/);
  });
});
