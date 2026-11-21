import type { Context } from "../context.js";
import { git } from "../files.js";
import { finding } from "../rules.js";
import type { CheckResult, Finding } from "../types.js";

const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

/** Paths that are documentation or tooling config, not "code" for freshness purposes. */
const NOT_CODE = [
  /\.md$/i,
  /^docs\//,
  /^\.agents\//,
  /^\.claude\//,
  /^\.gemini\//,
  /^\.github\//,
  /^\.azuredevops\//,
  /^(?:LICENSE|\.gitignore|\.gitattributes|\.editorconfig|\.dockerignore)$/,
];

function resolveBase(ctx: Context): { ref: string; mergeBase: string } | undefined {
  const explicit = ctx.options.baseRef ?? process.env.PLATFORM_CHECK_BASE_REF;
  const candidates = explicit ? [explicit] : BASE_CANDIDATES;
  for (const ref of candidates) {
    if (git(ctx.dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === undefined) continue;
    const mb = git(ctx.dir, ["merge-base", ref, "HEAD"])?.trim();
    if (mb) return { ref, mergeBase: mb };
  }
  return undefined;
}

export function checkDocs(ctx: Context): CheckResult {
  const findings: Finding[] = [];

  for (const doc of ["README.md", "CHANGELOG.md"]) {
    if (!ctx.exists(doc)) {
      findings.push(
        finding("PC041", {
          message: `${doc} is missing.`,
          file: doc,
          hint: `Add a ${doc}. The portal shows README and CHANGELOG to the people who use your app.`,
          aiPrompt: `Create ${doc} in the repository root (README: what the app does, how to run it locally, who owns it; CHANGELOG: Keep a Changelog format with an [Unreleased] section). Then run "platform check".`,
        }),
      );
    }
  }

  const base = resolveBase(ctx);
  if (!base) {
    return {
      group: "docs",
      findings,
      skipped: {
        reason: "freshness check needs a git base ref (use --base <ref> or PLATFORM_CHECK_BASE_REF; shallow clones may not have one)",
        strictExempt: true,
      },
    };
  }

  const changed = new Set<string>();
  const diff = git(ctx.dir, ["diff", "--name-only", "--relative", base.mergeBase]);
  for (const f of (diff ?? "").split("\n").filter(Boolean)) changed.add(f);
  const untracked = git(ctx.dir, ["ls-files", "-o", "--exclude-standard"]);
  for (const f of (untracked ?? "").split("\n").filter(Boolean)) changed.add(f);

  const codeChanged = [...changed].filter((f) => !NOT_CODE.some((re) => re.test(f)));
  if (codeChanged.length > 0 && !changed.has("CHANGELOG.md") && ctx.exists("CHANGELOG.md")) {
    const sample = codeChanged.slice(0, 3).join(", ") + (codeChanged.length > 3 ? ", ..." : "");
    findings.push(
      finding("PC040", {
        message: `Code changed since ${base.ref} (${codeChanged.length} file${codeChanged.length === 1 ? "" : "s"}: ${sample}) but CHANGELOG.md did not.`,
        file: "CHANGELOG.md",
        hint: "Add a short line about this change under [Unreleased] in CHANGELOG.md, so people using the app can see what changed.",
        aiPrompt: `Summarise the changes since ${base.ref} in one or two plain-language lines under "[Unreleased]" in CHANGELOG.md (user-visible effect, not implementation details). Then run "platform check".`,
      }),
    );
  }
  return { group: "docs", findings, notes: [`Compared against ${base.ref} (${changed.size} changed file${changed.size === 1 ? "" : "s"}).`] };
}
