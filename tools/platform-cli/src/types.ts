export type Severity = "error" | "warning" | "note";

export type GroupId =
  | "manifest"
  | "dockerfile"
  | "secrets"
  | "forbidden-files"
  | "docs"
  | "access"
  | "agent-files"
  | "runtime";

export const GROUP_ORDER: GroupId[] = [
  "manifest",
  "dockerfile",
  "secrets",
  "forbidden-files",
  "docs",
  "access",
  "agent-files",
  "runtime",
];

export const GROUP_TITLES: Record<GroupId, string> = {
  manifest: "platform.yaml",
  dockerfile: "Dockerfile",
  secrets: "Secrets",
  "forbidden-files": "Forbidden files",
  docs: "Documentation",
  access: "Access policy and the signed-in user",
  "agent-files": "AI agent files",
  runtime: "Runtime smoke test",
};

export interface Finding {
  ruleId: string;
  group: GroupId;
  severity: Severity;
  message: string;
  /** Path relative to the checked directory, POSIX separators. */
  file?: string;
  line?: number;
  column?: number;
  /** One line, plain language, for people who do not write code. */
  hint: string;
  /** A prompt a developer can paste into their AI agent. */
  aiPrompt: string;
  /** Stable key used for SARIF partial fingerprints (never contains secret values). */
  fingerprintSeed?: string;
}

export interface SkipInfo {
  reason: string;
  /** Skips that --strict does not turn into failures (warning-level checks). */
  strictExempt?: boolean;
}

export interface CheckResult {
  group: GroupId;
  findings: Finding[];
  skipped?: SkipInfo;
  /** Informational lines shown in the text summary. */
  notes?: string[];
  durationMs?: number;
}

export interface CheckOptions {
  dir: string;
  skipRuntime: boolean;
  strict: boolean;
  /** Restrict the run to these groups (undefined = all). */
  only?: GroupId[];
  baseRef?: string;
  allowlistPath?: string;
  agentManifestPath?: string;
  /** Use an existing image for the runtime smoke test instead of building one. */
  image?: string;
  maxFileMb: number;
  gitleaks: "auto" | "off" | "require";
  smokeTimeoutSec: number;
  /** The UTC date the enforceFrom of a rule is compared with (YYYY-MM-DD); default today (tests set it). */
  today?: string;
}
