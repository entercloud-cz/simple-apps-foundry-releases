import type { Context, ManifestData, ManifestRuntime } from "../context.js";
import { MANIFEST_FILE } from "../context.js";
import { finding } from "../rules.js";
import { validateData } from "../schema.js";
import type { CheckResult, Finding } from "../types.js";

// TODO(verify): ADR-0020 says "not an Azure reserved word" without listing the words. This is a
// conservative starting list; replace it with the verified list once the naming spike has one.
export const RESERVED_APP_WORDS = ["azure", "login", "office", "office365", "skype", "xbox", "bing", "live", "onedrive", "sharepoint"];
export const RESERVED_SUBSTRINGS = ["microsoft", "windows"];

/** The reserved word an app slug uses, if any (shared with `platform validate app`). */
export function reservedWordIn(slug: string): string | undefined {
  return RESERVED_APP_WORDS.includes(slug) ? slug : RESERVED_SUBSTRINGS.find((s) => slug.includes(s));
}

export function checkManifest(ctx: Context): CheckResult {
  const findings: Finding[] = [];
  const m = ctx.manifest;

  if (!m.exists) {
    findings.push(
      finding("PC001", {
        message: `${MANIFEST_FILE} not found in the repository root.`,
        file: MANIFEST_FILE,
        hint: "Every app needs a platform.yaml next to the Dockerfile. Copy it from the starter template.",
        aiPrompt: `Create a ${MANIFEST_FILE} in the repository root with schemaVersion "1.0-draft" and the registered app slug, following the platform.yaml schema (see the app-contract-and-docker skill). Then run "platform check".`,
      }),
    );
    return { group: "manifest", findings };
  }

  if (m.parsed && m.parsed.parseErrors.length) {
    for (const e of m.parsed.parseErrors) {
      findings.push(
        finding("PC001", {
          message: `${MANIFEST_FILE} is not valid YAML: ${e.message}`,
          file: MANIFEST_FILE,
          line: e.line,
          column: e.column,
          hint: "The file has a typing mistake (indentation, a missing colon or quote). Fix the marked line.",
          aiPrompt: `${MANIFEST_FILE} is not valid YAML at line ${e.line}: "${e.message}". Fix the syntax without changing its meaning, then run "platform check".`,
        }),
      );
    }
    return { group: "manifest", findings };
  }

  if (!m.data) {
    findings.push(
      finding("PC001", {
        message: `${MANIFEST_FILE} must contain a YAML mapping (key: value pairs) at the top level.`,
        file: MANIFEST_FILE,
        hint: "The file is empty or is a list. It must start with 'schemaVersion:' and 'app:'.",
        aiPrompt: `${MANIFEST_FILE} is empty or has the wrong top-level type. Rewrite it as a mapping with schemaVersion and app, following the schema, then run "platform check".`,
      }),
    );
    return { group: "manifest", findings };
  }

  const problems = validateData("manifest", m.parsed?.data, m.parsed);
  for (const p of problems) {
    findings.push(
      finding("PC002", {
        message: `${p.path}: ${p.message}.`,
        file: MANIFEST_FILE,
        ...(p.line !== undefined ? { line: p.line } : {}),
        ...(p.column !== undefined ? { column: p.column } : {}),
        hint: p.help ? `Fix "${p.path}" in platform.yaml. ${p.help}` : `Fix "${p.path}" in platform.yaml: it ${p.message}.`,
        aiPrompt: `In ${MANIFEST_FILE}, "${p.path}" ${p.message}${p.line ? ` (line ${p.line})` : ""}. Fix it according to config/schema/app-manifest.schema.json semantics, keep other settings unchanged, then run "platform check".`,
        fingerprintSeed: `${p.path}|${p.keyword}`,
      }),
    );
  }

  // Semantic checks only make sense on a structurally valid document.
  if (problems.length === 0) findings.push(...semanticChecks(ctx));
  return { group: "manifest", findings };
}

function lineOf(ctx: Context, path: (string | number)[]): number | undefined {
  const parsed = ctx.manifest.parsed;
  if (!parsed) return undefined;
  const node = parsed.doc.getIn(path, true) as { range?: [number, number, number] } | null | undefined;
  if (node && typeof node === "object" && node.range) return parsed.lc.linePos(node.range[0]).line;
  return undefined;
}

function semanticChecks(ctx: Context): Finding[] {
  const data = ctx.manifest.data;
  if (!data) return [];
  return consistencyProblems(data, (path) => lineOf(ctx, path)).map(({ message, hint, line }) =>
    finding("PC003", {
      message,
      file: MANIFEST_FILE,
      ...(line !== undefined ? { line } : {}),
      hint,
      aiPrompt: `In ${MANIFEST_FILE}: ${message} ${hint} Then run "platform check".`,
    }),
  );
}

export interface ConsistencyProblem {
  message: string;
  hint: string;
  line?: number;
}

/**
 * PC003: consistency of a schema-valid platform.yaml (reserved app words, secret references,
 * duplicate env vars, minReplicas > maxReplicas). Shared with `platform pipeline release-inputs`.
 */
export function consistencyProblems(data: ManifestData, lineAt: (path: (string | number)[]) => number | undefined = () => undefined): ConsistencyProblem[] {
  const out: ConsistencyProblem[] = [];
  const add = (message: string, hint: string, line?: number): void => {
    out.push({ message, hint, ...(line !== undefined ? { line } : {}) });
  };

  const slug = data.app ?? "";
  const hit = reservedWordIn(slug);
  if (hit) {
    add(
      `app "${slug}" uses a reserved word ("${hit}").`,
      "Use the app name that was registered in the portal; names with reserved words are rejected.",
      lineAt(["app"]),
    );
  }

  const declared = new Set(data.secrets ?? []);
  const scopes: { label: string; rt: ManifestRuntime | undefined; path: (string | number)[] }[] = [
    { label: "runtime", rt: data.runtime, path: ["runtime"] },
    ...Object.entries(data.environments ?? {}).map(([name, rt]) => ({
      label: `environments.${name}`,
      rt,
      path: ["environments", name] as (string | number)[],
    })),
  ];

  for (const { label, rt, path } of scopes) {
    if (!rt) continue;
    const names = new Set<string>();
    (rt.env ?? []).forEach((e, i) => {
      if (!e) return;
      if (e.secret && !declared.has(e.secret)) {
        add(
          `${label}.env[${i}] (${e.name}) uses secret "${e.secret}" that is not listed in the top-level "secrets".`,
          `Add "${e.secret}" to the "secrets:" list in platform.yaml (names only, never values).`,
          lineAt([...path, "env", i]),
        );
      }
      if (names.has(e.name)) {
        add(
          `${label}.env[${i}]: environment variable ${e.name} is defined twice.`,
          "Remove the duplicate entry.",
          lineAt([...path, "env", i]),
        );
      }
      names.add(e.name);
    });
    const min = rt.scale?.minReplicas;
    const max = rt.scale?.maxReplicas;
    if (min !== undefined && max !== undefined && min > max) {
      add(
        `${label}.scale: minReplicas (${min}) is greater than maxReplicas (${max}).`,
        "Make minReplicas smaller than or equal to maxReplicas.",
        lineAt([...path, "scale"]),
      );
    }
  }
  return out;
}
