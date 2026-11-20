/**
 * The onboarding plan as text, Markdown and JSON (`platform instance plan`, ADR-0072). Browser-safe like
 * plan.ts: no Node imports.
 *
 * Placeholders in commands (plan.ts, Command) are filled from a PlanContext: `platform instance plan --instance`
 * fills <host> and <prefix> and lists a per-environment step once per environment; `status` fills what it read.
 */
import { ACTORS, CHECKS, CONDITIONS, GATES, PHASES, PLAN_FORMAT_VERSION, STEPS, actorsOf, stepsOf } from "./plan.js";
import type { Command, Lang, Step, Text } from "./plan.js";

export interface PlanContext {
  host?: string;
  /** Every environment, the portal host first. */
  environments?: readonly string[];
  prefix?: string;
  /** Other placeholders: portal-url, portal-client-id, portal-object-id, sender. */
  values?: Readonly<Record<string, string>>;
}

export const tr = (t: Text, lang: Lang): string => t[lang];

/** <name> placeholders filled from the context; <env> with `env` when given. Unknown ones stay. */
export function fill(text: string, ctx: PlanContext, env?: string): string {
  return text.replace(/<([a-z][a-z-]*)>/g, (all, name: string) => {
    if (name === "env") return env ?? all;
    if (name === "host") return ctx.host ?? all;
    if (name === "prefix") return ctx.prefix ?? all;
    return ctx.values?.[name] ?? all;
  });
}

/** The environments a step's commands run for: every one (the host first), or every one but the host. */
export function stepEnvironments(step: Step, ctx: PlanContext): readonly string[] | undefined {
  if (!step.forEach || !ctx.environments) return undefined;
  return step.forEach === "environment" ? ctx.environments : ctx.environments.filter((e) => e !== ctx.host);
}

/** The step's commands, filled; a per-environment step's once for each of `envs` (default: its environments). */
export function stepCommands(step: Step, ctx: PlanContext, envs?: readonly string[]): Command[] {
  const list = envs ?? stepEnvironments(step, ctx);
  const one = (env?: string): Command[] => step.commands.map((cmd) => ({ ...cmd, run: fill(cmd.run, ctx, env) }));
  return list ? list.flatMap((e) => one(e)) : one();
}

/** "`a`, then with `--apply`" for a preview and its --apply; otherwise the commands joined by "then". */
export function commandsLine(cmds: readonly Command[], lang: Lang, code = (s: string): string => `\`${s}\``): string {
  const then = lang === "cs" ? "pak" : "then";
  const withApply = lang === "cs" ? "pak s" : "then with";
  const parts: string[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]!;
    const next = cmds[i + 1];
    if (next && next.run === `${cmd.run} --apply`) {
      parts.push(`${code(cmd.run)}, ${withApply} ${code("--apply")}`);
      i++;
    } else parts.push(code(cmd.run));
  }
  return parts.join(`; ${then} `);
}

/** Who: the step's actor, then its tasks' actors. */
export function whoLine(step: Step, lang: Lang): string {
  return actorsOf(step)
    .map((a) => tr(ACTORS[a], lang))
    .join(", ");
}

/** What to do, in one line: the action text, the commands, the pipeline run. */
export function doLine(step: Step, ctx: PlanContext, lang: Lang, code?: (s: string) => string): string {
  const parts: string[] = [];
  const action = step.action ? fill(tr(step.action, lang), ctx) : step.pipeline && !step.action ? fill(step.pipeline, ctx) : "";
  if (action) parts.push(action);
  if (step.commands.length) parts.push(commandsLine(stepCommands(step, ctx), lang, code));
  return parts.join(lang === "cs" ? "; " : "; ");
}

const LABELS = {
  en: {
    plan: (phases: number, steps: number): string => `Onboarding an instance: ${phases} phases, ${steps} steps. instance.sh status shows where you are (read only).`,
    phase: "Phase",
    who: "who",
    needs: "needs",
    gate: "gate",
  },
  cs: {
    plan: (phases: number, steps: number): string => `Onboarding instance: ${phases} fáze, ${steps} kroků. instance.sh status ukáže, kde jsi (jen čte).`,
    phase: "Fáze",
    who: "kdo",
    needs: "potřebuje",
    gate: "schválení",
  },
} as const;

/** `platform instance plan` as text: every phase and step, who does it, the command. */
export function planText(lang: Lang, ctx: PlanContext = {}): string {
  const L = LABELS[lang];
  const out: string[] = [L.plan(PHASES.length, STEPS.length), ""];
  for (const phase of PHASES) {
    out.push(`${L.phase} ${phase.id}: ${tr(phase.title, lang)} (${tr(phase.description, lang)})`);
    for (const step of stepsOf(phase.id)) {
      out.push(`  ${step.id}  ${tr(step.title, lang)}${step.onlyWhen ? ` (${tr(CONDITIONS[step.onlyWhen], lang)})` : ""}`);
      const who = `${L.who}: ${whoLine(step, lang)}${step.needs ? ` (${fill(tr(step.needs, lang), ctx)})` : ""}`;
      out.push(`       ${who}`);
      const action = step.action ? fill(tr(step.action, lang), ctx) : "";
      if (action) out.push(`       ${action}`);
      for (const cmd of stepCommands(step, ctx)) out.push(`       $ ${cmd.run}`);
      if (step.gates.length) out.push(`       ${L.gate}: ${step.gates.map((g) => tr(GATES[g], lang)).join("; ")}`);
      for (const [i, task] of (step.tasks ?? []).entries()) {
        out.push(`       ${i + 1}. ${tr(task.title, lang)} (${tr(ACTORS[task.actor], lang)})`);
        for (const cmd of task.commands) out.push(`          $ ${fill(cmd.run, ctx)}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export const PLAN_BLOCK_START = "<!-- onboarding-plan:start";
export const PLAN_BLOCK_END = "<!-- onboarding-plan:end -->";

/** A runbook link relative to `from` (a path from the repository root, docs/runbooks/onboard-instance.md). */
export function runbookLink(target: string, from: string): string {
  const [file, anchor] = target.split("#") as [string, string | undefined];
  const fromParts = from.split("/").slice(0, -1);
  const toParts = file.split("/");
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  const rel = [...fromParts.slice(common).map(() => ".."), ...toParts.slice(common)].join("/");
  const sameFile = file === from;
  return `${sameFile ? "" : rel}${anchor ? `#${anchor}` : ""}`;
}

/** The runbook section's label for a link: "step 4" for onboard-instance.md, else the file's name. */
function sectionLabel(target: string, lang: Lang): string {
  const [file, anchor] = target.split("#") as [string, string | undefined];
  const n = /^(\d+)-/.exec(anchor ?? "");
  if (file.endsWith("/onboard-instance.md") && n) return lang === "cs" ? `krok ${n[1]}` : `step ${n[1]}`;
  return file.split("/").pop()!.replace(/\.md$/, "");
}

/**
 * `platform instance plan --format markdown`: the checklist at the top of docs/runbooks/onboard-instance.md, between
 * its marker comments (a test compares them). Links are relative to `from`.
 */
export function planMarkdown(lang: Lang, ctx: PlanContext = {}, from = "docs/runbooks/onboard-instance.md"): string {
  // Escapes Markdown outside `code` spans, which stay as they are.
  const md = (s: string): string => s.split(/(`[^`]*`)/).map((part) => (part.startsWith("`") ? part : part.replace(/([*_[\]<>|\\])/g, "\\$1"))).join("");
  const out: string[] = [];
  for (const phase of PHASES) {
    out.push(`**${md(tr(phase.title, lang))}** (\`${phase.id}\`): ${md(tr(phase.description, lang))}.`, "");
    for (const step of stepsOf(phase.id)) {
      const when = step.onlyWhen ? ` (${md(tr(CONDITIONS[step.onlyWhen], lang))})` : "";
      const what = doLine(step, ctx, lang);
      const parts = [`**${step.id}** ${md(tr(step.title, lang))}${when}`, `*${whoLine(step, lang)}*`];
      if (what) parts.push(md(what));
      parts.push(`[${sectionLabel(step.runbook, lang)}](${runbookLink(step.runbook, from)})`);
      out.push(`- [ ] ${parts.join(" · ")}`);
      for (const task of step.tasks ?? []) {
        const cmds = task.commands.length ? ` · ${commandsLine(task.commands.map((x) => ({ ...x, run: fill(x.run, ctx) })), lang)}` : "";
        out.push(`  - ${md(tr(task.title, lang))} · *${tr(ACTORS[task.actor], lang)}*${cmds}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

/** The marker block for the runbook: the start comment, the checklist, the end comment. */
export function planMarkdownBlock(lang: Lang = "en"): string {
  return `${PLAN_BLOCK_START} (generated by platform instance plan --format markdown --update docs/runbooks/onboard-instance.md from tools/platform-cli/src/onboarding/plan.ts: edit that file, not this list) -->\n\n${planMarkdown(lang)}\n${PLAN_BLOCK_END}`;
}

/** Replaces the marker block in `text`, or undefined when it has none (or only one marker). */
export function withPlanBlock(text: string, block: string): string | undefined {
  const start = text.indexOf(PLAN_BLOCK_START);
  const end = text.indexOf(PLAN_BLOCK_END);
  if (start < 0 || end < start) return undefined;
  return text.slice(0, start) + block + text.slice(end + PLAN_BLOCK_END.length);
}

/** The marker block of `text` as it is, or undefined. */
export function planBlockOf(text: string): string | undefined {
  const start = text.indexOf(PLAN_BLOCK_START);
  const end = text.indexOf(PLAN_BLOCK_END);
  if (start < 0 || end < start) return undefined;
  return text.slice(start, end + PLAN_BLOCK_END.length);
}

/** `platform instance plan --format json`: the definition itself, placeholders filled from the context. */
export function planJson(ctx: PlanContext = {}): unknown {
  return {
    formatVersion: PLAN_FORMAT_VERSION,
    phases: PHASES.map((p) => ({ ...p, steps: stepsOf(p.id).map((s) => s.id) })),
    actors: ACTORS,
    gates: GATES,
    conditions: CONDITIONS,
    checks: CHECKS,
    steps: STEPS.map((s) => ({ ...s, commands: stepCommands(s, ctx), ...(s.action ? { action: { en: fill(s.action.en, ctx), cs: fill(s.action.cs, ctx) } } : {}) })),
  };
}
