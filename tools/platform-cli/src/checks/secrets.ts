import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isAllowed } from "../allowlist.js";
import type { Allowlist } from "../allowlist.js";
import type { Context } from "../context.js";
import { looksBinary, toPosix } from "../files.js";
import { finding } from "../rules.js";
import type { CheckResult, Finding } from "../types.js";

interface SecretRule {
  id: string;
  description: string;
  re: RegExp;
  /** Capture group holding the secret value (default: whole match). */
  group?: number;
  /** Extra condition on the matched value / line. */
  accept?: (value: string, line: string) => boolean;
  /** Never echo any part of the value (private keys). */
  noPreview?: boolean;
}

const PLACEHOLDER_RE =
  /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|\$\([^)]*\)|\{\{[^}]*\}\}|%[^%]*%|\[[^\]]*\]|change[-_]?me|password\d*|passwd|secret|example|dummy|placeholder|redacted|todo|none|null|undefined|your[-_ a-z]*|my[-_]?(?:secret|password|key|token)|test|testing|admin|user|username)$/i;

export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length < 3) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (/^(?:<|\{\{|\$\{|\$\(|%[^%]*%$)/.test(v)) return true;
  if (/(?:example|placeholder|changeme|your[-_]|<.*>|\$\{|\{\{|process\.env|os\.environ|getenv)/i.test(v)) return true;
  return false;
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export const SECRET_RULES: SecretRule[] = [
  { id: "private-key", description: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, noPreview: true },
  { id: "aws-access-key-id", description: "AWS access key ID", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/ },
  { id: "github-token", description: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/ },
  { id: "slack-token", description: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-api-key", description: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-live-key", description: "Stripe live key", re: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/ },
  { id: "npm-token", description: "npm access token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "sendgrid-key", description: "SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { id: "azure-ad-client-secret", description: "Microsoft Entra client secret", re: /\b[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}\b/ },
  { id: "azure-storage-account-key", description: "Azure storage account key", re: /AccountKey=([A-Za-z0-9+/]{40,}={0,2})/, group: 1, accept: (v) => !isPlaceholder(v) },
  {
    id: "azure-sas-signature",
    description: "Azure SAS token signature",
    re: /[?&;]sig=([A-Za-z0-9%+/=]{30,})/,
    group: 1,
    accept: (_v, line) => /\bsv=\d{4}-\d{2}-\d{2}/.test(line),
  },
  {
    id: "connection-string-password",
    description: "password inside a connection string",
    re: /\b(?:Password|Pwd)=([^;'"\s`]{3,})/i,
    group: 1,
    accept: (v, line) => !isPlaceholder(v) && /\b(?:Server|Data Source|Host|Initial Catalog|Database|User Id|UID|Port)=/i.test(line),
  },
  {
    id: "url-embedded-credentials",
    description: "password inside a URL",
    re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|ftps?|https?):\/\/[^\s:/@'"`]+:([^\s@'"`/]{3,})@[^\s'"`/]+/i,
    group: 1,
    accept: (v) => !isPlaceholder(v),
  },
  {
    id: "generic-secret-assignment",
    description: "hard-coded secret value",
    re: /\b[\w.-]*(?:secret|passwd|password|pwd|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key|token)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{16,})["']/i,
    group: 1,
    accept: (v) => !isPlaceholder(v) && /[A-Za-z]/.test(v) && /\d/.test(v) && shannonEntropy(v) >= 3.5 && !/^[A-Za-z0-9+/_-]*\.(?:js|ts|json|yaml|yml|png|svg)$/.test(v),
  },
];

const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_LINE = 10_000;
const SKIP_FILES = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/;

export function fingerprintOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function preview(value: string, noPreview?: boolean): string {
  if (noPreview) return "value hidden";
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}...(${value.length} chars)`;
}

const FIX_HINT =
  "Remove the secret from the file, treat it as leaked and replace it at its source, then read it from an environment variable that is set from Key Vault (list its name under 'secrets:' in platform.yaml).";

function aiPrompt(file: string, line: number, what: string): string {
  return `A ${what} is hard-coded at ${file}:${line}. Do NOT print or copy the value. Replace it with a read from an environment variable, declare the secret NAME (not the value) under "secrets:" in platform.yaml and reference it in runtime.env, remove the value from the file, and tell the app owner to rotate the leaked credential. Then run "platform check".`;
}

export function scanText(text: string): { rule: SecretRule; line: number; value: string }[] {
  const hits: { rule: SecretRule; line: number; value: string }[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.length > MAX_LINE) return;
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const value = rule.group !== undefined ? (m[rule.group] ?? "") : m[0];
      if (rule.accept && !rule.accept(value, line)) continue;
      hits.push({ rule, line: idx + 1, value });
    }
  });
  // A line that matched a vendor-specific rule is not reported again by the generic rule.
  const specific = new Set(hits.filter((h) => h.rule.id !== "generic-secret-assignment").map((h) => h.line));
  return hits.filter((h) => h.rule.id !== "generic-secret-assignment" || !specific.has(h.line));
}

export function checkSecrets(ctx: Context, allowlist: Allowlist | undefined): CheckResult {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let suppressed = 0;

  for (const rel of ctx.repoFiles.files) {
    if (SKIP_FILES.test(rel)) continue;
    const abs = ctx.abs(rel);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size === 0 || size > MAX_SCAN_BYTES || looksBinary(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scanned++;
    for (const hit of scanText(text)) {
      const key = `${rel}:${hit.line}:${hit.rule.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fp = fingerprintOf(hit.value);
      if (isAllowed(allowlist, { ruleId: hit.rule.id, file: rel, fingerprint: fp })) {
        suppressed++;
        continue;
      }
      findings.push(
        finding("PC020", {
          message: `Possible ${hit.rule.description} (${hit.rule.id}) at ${rel}:${hit.line}, value ${preview(hit.value, hit.rule.noPreview)}, fingerprint ${fp}.`,
          file: rel,
          line: hit.line,
          hint: FIX_HINT,
          aiPrompt: aiPrompt(rel, hit.line, hit.rule.description),
          fingerprintSeed: `${hit.rule.id}|${fp}`,
        }),
      );
    }
  }
  notes.push(`Scanned ${scanned} text files with ${SECRET_RULES.length} built-in rules.`);
  if (suppressed) notes.push(`${suppressed} finding(s) suppressed by the platform allowlist.`);
  if (allowlist?.expired.length) notes.push(`${allowlist.expired.length} expired allowlist entr${allowlist.expired.length === 1 ? "y" : "ies"} ignored.`);

  const g = runGitleaks(ctx, allowlist, findings);
  notes.push(...g.notes);
  findings.push(...g.findings);
  if (g.skipped) return { group: "secrets", findings, notes, skipped: g.skipped };
  return { group: "secrets", findings, notes };
}

interface GitleaksResult {
  findings: Finding[];
  notes: string[];
  skipped?: { reason: string };
}

function hasGitleaks(): boolean {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function runGitleaks(ctx: Context, allowlist: Allowlist | undefined, existing: Finding[]): GitleaksResult {
  const mode = ctx.options.gitleaks;
  if (mode === "off") return { findings: [], notes: ["gitleaks disabled (--gitleaks off)."] };
  if (!hasGitleaks()) {
    if (mode === "require") {
      return { findings: [], notes: [], skipped: { reason: "gitleaks is required (--gitleaks require) but not on PATH" } };
    }
    return { findings: [], notes: ["gitleaks not found on PATH, built-in rules only."] };
  }
  const tmp = mkdtempSync(join(tmpdir(), "platform-gitleaks-"));
  try {
    const report = join(tmp, "report.json");
    const config = join(tmp, "gitleaks.toml");
    // Platform-owned config: the repo's own .gitleaks.toml / .gitleaksignore are NOT honoured.
    writeFileSync(
      config,
      `[extend]\nuseDefault = true\n\n[allowlist]\npaths = ['''(^|/)(node_modules|bin|obj|\\.git)/''']\n`,
    );
    try {
      execFileSync(
        "gitleaks",
        ["detect", "--no-git", "--source", ctx.dir, "--config", config, "--no-banner", "--redact", "--report-format", "json", "--report-path", report, "--exit-code", "0"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
      );
    } catch (e) {
      return { findings: [], notes: [`gitleaks failed to run: ${(e as Error).message.split("\n")[0]}`] };
    }
    let list: { RuleID: string; Description: string; File: string; StartLine: number; Fingerprint?: string }[] = [];
    try {
      list = JSON.parse(readFileSync(report, "utf8") || "[]") as typeof list;
    } catch {
      return { findings: [], notes: ["gitleaks report could not be parsed, ignored."] };
    }
    const out: Finding[] = [];
    let suppressed = 0;
    for (const r of list) {
      const file = toPosix(relative(ctx.dir, r.File.startsWith("/") ? r.File : join(ctx.dir, r.File)));
      if (existing.some((f) => f.file === file && f.line === r.StartLine)) continue;
      const rid = `gitleaks:${r.RuleID}`;
      if (isAllowed(allowlist, { ruleId: rid, file, ...(r.Fingerprint ? { fingerprint: r.Fingerprint } : {}) })) {
        suppressed++;
        continue;
      }
      out.push(
        finding("PC021", {
          message: `gitleaks: ${r.Description} (${r.RuleID}) at ${file}:${r.StartLine}.`,
          file,
          line: r.StartLine,
          hint: FIX_HINT,
          aiPrompt: aiPrompt(file, r.StartLine, r.Description),
          fingerprintSeed: `${rid}|${file}|${r.StartLine}`,
        }),
      );
    }
    const notes = [`gitleaks ran: ${out.length} additional finding(s)${suppressed ? `, ${suppressed} allowlisted` : ""}.`];
    return { findings: out, notes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
