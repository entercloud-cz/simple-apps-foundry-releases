import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planSync, stubCreateText } from "../agentfiles.js";
import type { AgentLayout } from "../agentfiles.js";
import type { Context } from "../context.js";
import { finding } from "../rules.js";
import { parseYaml } from "../schema.js";
import type { CheckResult, Finding } from "../types.js";

const SYNC_CMD = 'run "platform sync-agent-files"';
const SYNC_SENTENCE = 'Run "platform sync-agent-files".';
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_KEYS = new Set(["name", "description", "license", "compatibility", "metadata"]);

export function checkAgentFiles(ctx: Context, layout: AgentLayout): CheckResult {
  const findings: Finding[] = [];
  const dir = ctx.dir;

  // PC053: AGENTS.md exists and is small enough.
  const agentsMd = ctx.abs("AGENTS.md");
  try {
    const st = lstatSync(agentsMd);
    if (st.isFile() && st.size >= layout.agentsMdMaxBytes) {
      findings.push(
        finding("PC053", {
          message: `AGENTS.md is ${st.size} bytes; it must stay under ${layout.agentsMdMaxBytes} bytes (32 KiB), because some agents cut off longer files.`,
          file: "AGENTS.md",
          hint: "Shorten AGENTS.md: move details into skills under .agents/skills/ and keep only the rules every task needs.",
          aiPrompt: `AGENTS.md is ${st.size} bytes, the limit is ${layout.agentsMdMaxBytes}. Move detailed procedures into skills in .agents/skills/<name>/SKILL.md, keep AGENTS.md short, then run "platform sync-agent-files" and "platform check".`,
        }),
      );
    }
  } catch {
    findings.push(
      finding("PC053", {
        message: "AGENTS.md is missing.",
        file: "AGENTS.md",
        hint: "AGENTS.md holds the instructions for AI agents. Restore it from the starter template.",
        aiPrompt: 'AGENTS.md is missing from the repository root. Restore it from the app template (templates/app/agent-files/AGENTS.md.tmpl) or git history, then run "platform check".',
      }),
    );
  }

  // PC054: symlinks anywhere in the agent files and folders.
  const symlinks: string[] = [];
  const scanLinks = (rel: string): void => {
    let st;
    try {
      st = lstatSync(join(dir, rel));
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      symlinks.push(rel);
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(join(dir, rel))) scanLinks(`${rel}/${name}`);
    }
  };
  const linkRoots = new Set<string>([".agents", ".claude", ".gemini", "CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md", layout.skillsSource.split("/")[0] as string, ...layout.skillMirrors.map((m) => m.split("/")[0] as string)]);
  for (const r of linkRoots) scanLinks(r);
  for (const l of symlinks.sort()) {
    findings.push(
      finding("PC054", {
        message: `${l} is a symbolic link. Symlinks turn into plain text files on Windows checkouts and break the agent files.`,
        file: l,
        hint: `Replace the link with a real file or folder, then ${SYNC_CMD}.`,
        aiPrompt: `${l} is a symlink. Replace it with a real file/folder copy (no symlinks in agent files), then run "platform sync-agent-files" and "platform check".`,
      }),
    );
  }

  // PC050: SKILL.md frontmatter.
  const skillsRoot = join(dir, layout.skillsSource);
  let skillDirs: string[] = [];
  try {
    skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    /* no skills folder is fine */
  }
  for (const name of skillDirs) {
    findings.push(...checkSkill(ctx, layout, name));
  }

  // PC051: mirror drift and stubs, derived from the sync plan.
  const plan = planSync(dir, layout);
  for (const a of plan.actions) {
    if (a.cause === "mirror-missing" || a.cause === "mirror-differs" || a.cause === "mirror-extra") {
      findings.push(
        finding("PC051", {
          message: `${a.path} ${a.detail}.`,
          file: a.path,
          hint: `Edit skills only in ${layout.skillsSource}/, then ${SYNC_CMD} to refresh the generated copy.`,
          aiPrompt: `The generated skill mirror is out of date (${a.path} ${a.detail}). Make sure the intended change is in ${layout.skillsSource}/, then run "platform sync-agent-files" and re-run "platform check". Never edit the .claude/skills copy by hand.`,
          fingerprintSeed: `${a.cause}|${a.path}`,
        }),
      );
    } else if (a.stub) {
      const stub = a.stub;
      const ruleId = stub.ruleId;
      const missing = a.cause === "stub-missing";
      const base = {
        file: stub.path,
        severity: stub.severity,
        fingerprintSeed: `${a.cause}|${stub.path}`,
      } as const;
      if (ruleId === "PC052") {
        findings.push(
          finding("PC052", {
            ...base,
            message: missing ? `${stub.path} is missing; it must start with "@AGENTS.md".` : `${stub.path} ${a.detail}.`,
            hint: `Claude Code reads ${stub.path} and follows the import to AGENTS.md. ${SYNC_SENTENCE}`,
            aiPrompt: `${stub.path} must start with the line "@AGENTS.md" (it only imports AGENTS.md). Run "platform sync-agent-files" to fix it, then "platform check".`,
          }),
        );
      } else {
        findings.push(
          finding("PC055", {
            ...base,
            message: missing ? `${stub.path} is missing.` : `${stub.path} ${a.detail}.`,
            hint: `Generated helper file for AI tools. ${SYNC_SENTENCE} It creates or repairs this file.`,
            aiPrompt: `Run "platform sync-agent-files" to create or repair ${stub.path} (expected: ${truncate(stubCreateText(stub).trim(), 160)}), then run "platform check".`,
          }),
        );
      }
    }
  }
  for (const p of plan.problems) {
    if (p.message.includes("symbolic link")) continue; // already reported as PC054
    findings.push(
      finding("PC055", {
        message: `${p.path} ${p.message}.`,
        file: p.path,
        severity: p.stub?.severity ?? "warning",
        hint: "Fix the file by hand; sync cannot repair it automatically.",
        aiPrompt: `${p.path} ${p.message}. Repair it, then run "platform sync-agent-files --check".`,
      }),
    );
  }

  // PC056: copilot pointer should stay a short pointer.
  const copilot = ctx.readText(".github/copilot-instructions.md");
  if (copilot !== undefined && (copilot.split("\n").filter((l) => l.trim()).length > 8 || copilot.length > 1024)) {
    findings.push(
      finding("PC056", {
        message: ".github/copilot-instructions.md is longer than a short pointer to AGENTS.md; rules there will drift from AGENTS.md.",
        file: ".github/copilot-instructions.md",
        hint: "Keep it to a line or two that points to AGENTS.md. Put the rules in AGENTS.md.",
        aiPrompt: "Reduce .github/copilot-instructions.md to a short pointer to AGENTS.md and move any rules into AGENTS.md or a skill. Then run \"platform check\".",
      }),
    );
  }

  return { group: "agent-files", findings, notes: [`Layout: ${layout.source}.`] };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function checkSkill(ctx: Context, layout: AgentLayout, folder: string): Finding[] {
  const out: Finding[] = [];
  const rel = `${layout.skillsSource}/${folder}/SKILL.md`;
  const bad = (message: string, hint: string, line?: number, severity?: "warning"): void => {
    out.push(
      finding("PC050", {
        message,
        file: rel,
        ...(line !== undefined ? { line } : {}),
        ...(severity ? { severity } : {}),
        hint,
        aiPrompt: `Fix ${rel}: ${message} Skills need frontmatter with "name" (equal to the folder name "${folder}", lowercase letters, digits and single hyphens) and a "description" of 1-1024 characters. Then run "platform sync-agent-files" and "platform check".`,
        fingerprintSeed: `${folder}|${message}`,
      }),
    );
  };

  let st;
  try {
    st = lstatSync(ctx.abs(rel));
  } catch {
    bad("SKILL.md is missing in this skill folder.", "Every skill folder needs a SKILL.md. Add one or delete the folder.");
    return out;
  }
  if (st.isSymbolicLink()) return out; // PC054
  const text = readFileSync(ctx.abs(rel), "utf8").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    bad("must start with a '---' frontmatter block on line 1.", "Add a frontmatter block (--- name: ... description: ... ---) at the very top of the file.", 1);
    return out;
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    bad("frontmatter is not closed with '---'.", "Add a closing '---' line after the frontmatter.", 1);
    return out;
  }
  const parsed = parseYaml(text.slice(4, end));
  if (parsed.parseErrors.length || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    const e = parsed.parseErrors[0];
    bad(`frontmatter is not valid YAML${e ? ` (${e.message})` : ""}.`, "Fix the frontmatter syntax (quote values that contain a colon).", e ? e.line + 1 : 2);
    return out;
  }
  const fm = parsed.data as Record<string, unknown>;
  if (typeof fm.name !== "string" || fm.name === "") {
    bad('frontmatter needs a "name".', 'Add name: <folder name> to the frontmatter.', 2);
  } else {
    if (fm.name !== folder) bad(`name "${fm.name}" must equal the folder name "${folder}".`, `Set name to "${folder}" or rename the folder.`, 2);
    if (!NAME_RE.test(fm.name) || fm.name.length > 64) {
      bad(`name "${fm.name}" must be 1-64 characters: lowercase letters, digits and single hyphens.`, "Use a short lowercase-with-hyphens name.", 2);
    }
  }
  if (typeof fm.description !== "string" || fm.description.trim() === "") {
    bad('frontmatter needs a non-empty "description".', "Describe in one or two sentences what the skill does and when to use it.", 2);
  } else if (fm.description.length > 1024) {
    bad(`description is ${fm.description.length} characters; the limit is 1024.`, "Shorten the description.", 2);
  }
  for (const key of Object.keys(fm)) {
    if (!SAFE_KEYS.has(key)) {
      bad(`frontmatter key "${key}" is not portable across agents (allowed: ${[...SAFE_KEYS].join(", ")}).`, `Remove "${key}" from the frontmatter, other agents ignore or reject it.`, 2, "warning");
    }
  }
  if (fm.metadata !== undefined && (typeof fm.metadata !== "object" || fm.metadata === null || Array.isArray(fm.metadata) || Object.values(fm.metadata as object).some((v) => typeof v !== "string"))) {
    bad('"metadata" must be a map of strings.', "Use simple key: value text pairs under metadata.", 2);
  }
  return out;
}
