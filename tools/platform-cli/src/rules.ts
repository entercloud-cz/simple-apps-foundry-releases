import type { Finding, GroupId, Severity } from "./types.js";

export interface RuleDef {
  id: string;
  name: string;
  group: GroupId;
  severity: Severity;
  summary: string;
  /**
   * A check new to the delivery pipeline warns before it blocks (ADR-0049 section 7): before this
   * UTC date (YYYY-MM-DD) its errors are reported as warnings, with its explanation and the date;
   * from it on they are errors (enforcement.ts). Set it when a core release adds or tightens a
   * check; remove it once the date has passed in every supported core version.
   */
  enforceFrom?: string;
}

/** The authoritative list of check IDs. README table and SARIF rule metadata come from here. */
export const RULES: RuleDef[] = [
  { id: "PC001", name: "manifest-unreadable", group: "manifest", severity: "error", summary: "platform.yaml is missing or is not valid YAML." },
  { id: "PC002", name: "manifest-schema", group: "manifest", severity: "error", summary: "platform.yaml does not match the app manifest schema." },
  { id: "PC003", name: "manifest-semantic", group: "manifest", severity: "error", summary: "platform.yaml is schema-valid but inconsistent (undeclared secret, reserved app name, min > max replicas, duplicate env var)." },
  { id: "PC010", name: "dockerfile-missing", group: "dockerfile", severity: "error", summary: "Dockerfile is missing, unreadable or outside the repository." },
  { id: "PC011", name: "dockerfile-base-image-pinned", group: "dockerfile", severity: "error", summary: "Every FROM must use an exact version tag (x.y.z) or a sha256 digest; no latest, no floating tags." },
  { id: "PC012", name: "dockerfile-non-root", group: "dockerfile", severity: "error", summary: "The final stage must switch to a non-root USER." },
  { id: "PC013", name: "dockerfile-port", group: "dockerfile", severity: "error", summary: "EXPOSE / ENV PORT must agree with runtime.port in platform.yaml." },
  { id: "PC014", name: "dockerfile-expose-missing", group: "dockerfile", severity: "warning", summary: "The final stage has no EXPOSE for the app port." },
  { id: "PC020", name: "secret-detected", group: "secrets", severity: "error", summary: "A secret, key, token or password was found in a file." },
  { id: "PC021", name: "secret-detected-gitleaks", group: "secrets", severity: "error", summary: "gitleaks found a secret (only when gitleaks is installed)." },
  { id: "PC030", name: "forbidden-env-file", group: "forbidden-files", severity: "error", summary: "Env files must not be committed (.env, .env.*, *.env). Only example.env and .env.example are allowed." },
  { id: "PC031", name: "forbidden-directory", group: "forbidden-files", severity: "error", summary: "bin/, obj/ or node_modules/ must not be committed." },
  { id: "PC032", name: "forbidden-large-file", group: "forbidden-files", severity: "error", summary: "A file is larger than the allowed size." },
  { id: "PC033", name: "forbidden-key-store", group: "forbidden-files", severity: "error", summary: "Key or certificate store files (.pfx, .p12, .jks, .key, ...) must not be committed." },
  { id: "PC040", name: "docs-changelog-stale", group: "docs", severity: "warning", summary: "Code changed but CHANGELOG.md did not." },
  { id: "PC041", name: "docs-missing", group: "docs", severity: "warning", summary: "README.md or CHANGELOG.md is missing." },
  { id: "PC050", name: "agent-skill-frontmatter", group: "agent-files", severity: "error", summary: "SKILL.md is missing or its frontmatter is invalid (name must equal the folder name, description required)." },
  { id: "PC051", name: "agent-skill-mirror", group: "agent-files", severity: "error", summary: ".claude/skills/ is not byte-identical to .agents/skills/." },
  { id: "PC052", name: "agent-claude-import", group: "agent-files", severity: "error", summary: "CLAUDE.md must start with the line @AGENTS.md." },
  { id: "PC053", name: "agent-agents-md", group: "agent-files", severity: "error", summary: "AGENTS.md is missing or 32 KiB or larger." },
  { id: "PC054", name: "agent-symlink", group: "agent-files", severity: "error", summary: "Symbolic links are not allowed in agent files and folders." },
  { id: "PC055", name: "agent-stub", group: "agent-files", severity: "warning", summary: "A generated stub file (.gemini/settings.json, .claude/settings.json, .gitattributes, copilot pointer) is missing or wrong." },
  { id: "PC056", name: "agent-copilot-pointer-long", group: "agent-files", severity: "warning", summary: ".github/copilot-instructions.md is longer than a short pointer." },
  { id: "PC057", name: "agent-files-behind", group: "agent-files", severity: "warning", summary: "The agent files (AGENTS.md, the platform's skills, tool settings) are older than the platform's templates: run platform agent-files update (ADR-0076)." },
  { id: "PC060", name: "runtime-docker-unavailable", group: "runtime", severity: "error", summary: "Runtime smoke test could not run (docker not available); fails only with --strict." },
  { id: "PC061", name: "runtime-build-failed", group: "runtime", severity: "error", summary: "docker build failed." },
  { id: "PC062", name: "runtime-health", group: "runtime", severity: "error", summary: "The container did not answer the liveness path with 2xx in time." },
  { id: "PC063", name: "runtime-readiness", group: "runtime", severity: "error", summary: "The configured readiness path did not answer 2xx (error); 503 (not ready, e.g. waiting for a database the smoke test does not provide) is a warning. Without runtime.health.readiness, /readyz is only probed and a non-2xx answer is a warning." },
  { id: "PC064", name: "runtime-root", group: "runtime", severity: "error", summary: "The container runs as root (uid 0)." },
  { id: "PC065", name: "runtime-exited", group: "runtime", severity: "error", summary: "The container exited before it became healthy." },
];

/**
 * Checks of the delivery pipeline that are not rules of `platform check` (explanations.ts
 * PIPELINE_CHECK_IDS) and warn before they block (ADR-0049 section 7), with their enforcement date
 * (UTC, YYYY-MM-DD; enforcement.ts). capacity-reservation (ADR-0053): platform.yaml's size and
 * maxReplicas within the app's capacity reservation, 30 days after the release that brings it.
 */
export const PIPELINE_CHECK_ENFORCE_FROM: Readonly<Record<string, string>> = { "capacity-reservation": "2026-12-11" };

/**
 * Rule IDs are stable across CLI versions (US09.05): an ID is never reused for another check and
 * never disappears from reports and portals that stored it. A rule that is renamed or merged into
 * another keeps its old ID here, as `oldId: currentId`, so results written by an older CLI (a
 * SARIF file in an old pipeline run) still resolve to the current rule and its explanation.
 * Empty until the first rename; test/explanations.test.ts checks that every target is a current
 * rule and that no alias shadows a current ID.
 */
export const RULE_ALIASES: Readonly<Record<string, string>> = {};

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** The current ID of a rule: the ID itself, or what its alias points to; undefined for an unknown ID. */
export function canonicalRuleId(id: string): string | undefined {
  if (BY_ID.has(id)) return id;
  const target = Object.hasOwn(RULE_ALIASES, id) ? RULE_ALIASES[id] : undefined;
  return target !== undefined && BY_ID.has(target) ? target : undefined;
}

export function rule(id: string): RuleDef {
  const r = BY_ID.get(canonicalRuleId(id) ?? id);
  if (!r) throw new Error(`Unknown rule id ${id}`);
  return r;
}

export interface FindingInput {
  message: string;
  hint: string;
  aiPrompt: string;
  file?: string;
  line?: number;
  column?: number;
  severity?: Severity;
  fingerprintSeed?: string;
}

export function finding(ruleId: string, input: FindingInput): Finding {
  const r = rule(ruleId);
  return {
    ruleId,
    group: r.group,
    severity: input.severity ?? r.severity,
    message: input.message,
    hint: input.hint,
    aiPrompt: input.aiPrompt,
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
    ...(input.fingerprintSeed !== undefined ? { fingerprintSeed: input.fingerprintSeed } : {}),
  };
}
