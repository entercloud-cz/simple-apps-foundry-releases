import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { parse as parseYamlLib } from "yaml";
import { globMatch } from "./glob.js";

/**
 * The secret-scan allowlist is a PLATFORM-side file. It is passed with --allowlist (or the
 * PLATFORM_SECRETS_ALLOWLIST environment variable) by the pipeline or by the platform team.
 * It is never read from the app repository, and a path inside the checked directory is rejected,
 * so an app (or its AI agent) cannot allow-list its own secrets.
 */
export class UsageError extends Error {}

export interface AllowEntry {
  /** Rule id such as "aws-access-key-id" (built-in) or "gitleaks:generic-api-key". */
  ruleId?: string;
  /** Glob relative to the checked directory, e.g. "docs/**". */
  path?: string;
  /** First 16 hex chars of sha256(secret value), printed in the finding. Pins one exact value. */
  fingerprint?: string;
  reason: string;
  /** ISO date (YYYY-MM-DD). Expired entries are ignored. */
  expires?: string;
}

export interface Allowlist {
  source: string;
  entries: AllowEntry[];
  expired: AllowEntry[];
}

export function loadAllowlist(path: string, checkedDir: string, now = new Date()): Allowlist {
  const abs = resolve(path);
  let realFile: string;
  try {
    realFile = realpathSync(abs);
  } catch {
    throw new UsageError(`Allowlist file not found: ${path}`);
  }
  const realDir = realpathSync(resolve(checkedDir));
  const rel = relative(realDir, realFile);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new UsageError(
      `The secret allowlist must live outside the repository being checked (${path}). It can only be set by the platform, not by the app repo.`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYamlLib(readFileSync(realFile, "utf8"));
  } catch (e) {
    throw new UsageError(`Allowlist ${path} is not valid JSON/YAML: ${(e as Error).message}`);
  }
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) throw new UsageError(`Allowlist ${path} must have an "entries" list.`);
  const entries: AllowEntry[] = [];
  const expired: AllowEntry[] = [];
  list.forEach((e: unknown, i: number) => {
    const o = e as Partial<AllowEntry> | null;
    if (!o || typeof o !== "object") throw new UsageError(`Allowlist entry ${i} must be an object.`);
    if (typeof o.reason !== "string" || o.reason.trim().length < 5) {
      throw new UsageError(`Allowlist entry ${i} needs a "reason" (at least 5 characters).`);
    }
    const hasFp = typeof o.fingerprint === "string" && /^[0-9a-f]{16}$/.test(o.fingerprint);
    const hasRulePath = typeof o.ruleId === "string" && typeof o.path === "string";
    if (!hasFp && !hasRulePath) {
      throw new UsageError(`Allowlist entry ${i} must have a 16-hex "fingerprint", or both "ruleId" and "path" (no blanket entries).`);
    }
    if (o.expires !== undefined && Number.isNaN(Date.parse(o.expires))) {
      throw new UsageError(`Allowlist entry ${i} has an invalid "expires" date.`);
    }
    const entry = o as AllowEntry;
    if (entry.expires !== undefined && Date.parse(entry.expires) < now.getTime()) expired.push(entry);
    else entries.push(entry);
  });
  return { source: path, entries, expired };
}

export interface AllowQuery {
  ruleId: string;
  file: string;
  fingerprint?: string;
}

export function isAllowed(list: Allowlist | undefined, q: AllowQuery): AllowEntry | undefined {
  if (!list) return undefined;
  return list.entries.find((e) => {
    if (e.fingerprint !== undefined) {
      if (e.fingerprint !== q.fingerprint) return false;
      if (e.ruleId !== undefined && e.ruleId !== q.ruleId) return false;
      if (e.path !== undefined && !globMatch(e.path, q.file)) return false;
      return true;
    }
    return e.ruleId === q.ruleId && e.path !== undefined && globMatch(e.path, q.file);
  });
}
