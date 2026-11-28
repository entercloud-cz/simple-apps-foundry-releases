/**
 * ADR-0078: the starters' default access policy and the signed-in user (PC066, PC067, PC068).
 *
 * Only for an app repository the platform rendered with ADR-0078's agent files: one with `.platform/roles.json`.
 * Before the repository pulls them, PC057 says the agent files are behind; this group is skipped.
 *
 *   PC066  the default access policy (a source file with the marker `saf:access-policy`) or its contract test (a test
 *          file with `saf:access-contract-test`, not skipped) is missing;
 *   PC067  a role in `.platform/roles.json` has no level: it has no access in the app;
 *   PC068  an app with sign-in shows no signed-in user: no sign-out link (`/.auth/logout`) in its code.
 */
import type { Context } from "../context.js";
import { finding } from "../rules.js";
import type { CheckResult, Finding } from "../types.js";

const POLICY_MARKER = "saf:access-policy";
const TEST_MARKER = "saf:access-contract-test";
/** Source files that may hold the policy, the test or the user menu (no build output, dependencies or docs). */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|cs|cshtml|razor|html|vue|svelte)$/;
const IGNORED = /(^|\/)(node_modules|dist|build|bin|obj|\.venv|venv|__pycache__|\.git|coverage)\//;
/** A skipped test: Node's test runner and vitest/jest, pytest, xUnit and NUnit. */
const SKIPPED = /\b(describe|it|test)\.skip\s*\(|@pytest\.mark\.skip\b|pytest\.skip\s*\(|\bSkip\s*=\s*"|\[Ignore\b/;

export function checkAccess(ctx: Context): CheckResult {
  const text = ctx.readText(".platform/roles.json");
  if (text === undefined) {
    return {
      group: "access",
      findings: [],
      skipped: { reason: "no .platform/roles.json (the repository hasn't pulled the agent files of ADR-0078 yet: platform agent-files update)", strictExempt: true },
    };
  }
  const findings: Finding[] = [];
  let doc: { signIn?: unknown; roles?: unknown };
  try {
    doc = JSON.parse(text) as { signIn?: unknown; roles?: unknown };
  } catch {
    doc = {};
  }
  if (typeof doc.signIn !== "boolean" || !Array.isArray(doc.roles)) {
    findings.push(
      finding("PC067", {
        message: ".platform/roles.json is not the platform's roles file ({signIn, roles}).",
        file: ".platform/roles.json",
        hint: "Run platform agent-files update: it writes the file again from the portal.",
        aiPrompt: "Run `platform agent-files update` in the repository root, show the user the diff of .platform/roles.json and commit it with their OK.",
      }),
    );
    return { group: "access", findings };
  }
  if (!doc.signIn) return { group: "access", findings }; // a public app: no roles, no user

  for (const r of doc.roles as unknown[]) {
    const role = (typeof r === "object" && r !== null ? r : {}) as { value?: unknown; level?: unknown };
    if (typeof role.value !== "string") continue;
    if (role.level === "read" || role.level === "write" || role.level === "admin") continue;
    findings.push(
      finding("PC067", {
        message: `The role ${role.value.slice(0, 20)} has no level: nobody with it can use the app.`,
        file: ".platform/roles.json",
        hint: "The owner sets the role's level in the portal (Access tab: what the role may do); then platform agent-files update.",
        aiPrompt: `The app role ${role.value.slice(0, 20)} has no level in .platform/roles.json, so the app's access policy gives it no access. Tell the user to set its level (read, write or admin) on the app's Access tab in the portal, then run \`platform agent-files update\` and commit the result. Don't edit .platform/roles.json by hand.`,
      }),
    );
  }

  const sources = ctx.repoFiles.files.filter((f) => SOURCE.test(f) && !IGNORED.test(f));
  let policy: string | undefined;
  let test: string | undefined;
  let skippedTest: string | undefined;
  let signOut = false;
  for (const f of sources) {
    const body = ctx.readText(f);
    if (body === undefined) continue;
    if (!policy && body.includes(POLICY_MARKER) && !body.includes(TEST_MARKER)) policy = f;
    if (body.includes(TEST_MARKER)) {
      if (SKIPPED.test(body)) skippedTest ??= f;
      else test ??= f;
    }
    if (!signOut && body.includes("/.auth/logout")) signOut = true;
  }
  if (!policy) {
    findings.push(
      finding("PC066", {
        message: "The app has no default access policy (no source file with the marker saf:access-policy).",
        hint: "Every /api route needs the platform's default policy: reading needs the role level read, changing data write, the settings admin (skill auth-entra).",
        aiPrompt:
          "This app has sign-in but no default access policy. Load the skill auth-entra and add the platform's default policy as it describes: deny by default on every /api route, GET needs level read, POST/PUT/PATCH/DELETE need write, /api/admin/** and /api/settings/** need admin, levels from .platform/roles.json, exceptions only declared on their route. Mark the file with the comment saf:access-policy, add the contract test, run the tests and platform check.",
      }),
    );
  }
  if (!test) {
    findings.push(
      finding("PC066", {
        message: skippedTest
          ? `The access policy's contract test is skipped (${skippedTest}).`
          : "The access policy has no contract test (no test file with the marker saf:access-contract-test).",
        ...(skippedTest ? { file: skippedTest } : {}),
        hint: "The contract test checks every route against the role levels; it must run with the app's tests.",
        aiPrompt:
          "Load the skill auth-entra and add (or un-skip) the access policy's contract test: it walks every registered route and checks that a Reader is refused on every write and admin route, an Editor on every admin route, and a user without a role everywhere but `user` and `public` routes. Mark the file with the comment saf:access-contract-test, never skip it, and run the tests.",
      }),
    );
  }
  if (!signOut) {
    findings.push(
      finding("PC068", {
        message: "The app has sign-in but shows no signed-in user (no sign-out link /.auth/logout in its code).",
        hint: "Every app with sign-in shows the user, their roles, Sign out and Sign in as another user (skill ui-and-brand).",
        aiPrompt:
          "Load the skill ui-and-brand and add the user menu to the app's layout: the signed-in user's name and email (from /api/me), their roles with what each may do, a Sign out link to /.auth/logout?post_logout_redirect_uri=/ and a Sign in as another user link to /.auth/login/aad?prompt=select_account&post_login_redirect_uri=/. Check it in the browser preview and run platform check.",
      }),
    );
  }
  return { group: "access", findings };
}
