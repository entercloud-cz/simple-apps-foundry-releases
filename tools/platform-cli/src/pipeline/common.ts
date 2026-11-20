import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync, constants as fsc } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { UsageError } from "../allowlist.js";
import { parseYaml, validateData } from "../schema.js";

/**
 * A check failed: exit code 1, one stderr line per problem. Messages may contain untrusted text;
 * the dispatcher neutralises everything it prints.
 */
export class CheckFailed extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

export { UsageError };

export const KiB = 1024;
export const MiB = 1024 * KiB;

export const SLUG_RE = /^[a-z](-?[a-z0-9])+$/;
export const ENV_NAME_RE = /^[a-z][a-z0-9]{1,7}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const CORE_VERSION_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** A git ref as the agent passes it: no whitespace or control characters. */
export const REF_RE = /^refs\/[^\s\x00-\x1f\x7f]+$/u;
export const RESERVED_SLUGS = ["platform", "portal"];

export function slugProblem(slug: unknown, label: string): string | undefined {
  if (typeof slug !== "string") return `${label} must be a string.`;
  if (slug.length < 3 || slug.length > 20 || !SLUG_RE.test(slug)) {
    return `${label} "${slug}" is not a valid app slug (3-20 lowercase letters, digits and single hyphens, starts with a letter).`;
  }
  if (RESERVED_SLUGS.includes(slug)) return `${label} "${slug}" is reserved.`;
  return undefined;
}

/** Reads a whole regular file, refusing anything larger than `max` bytes (checked on the open fd). */
export function readCapped(path: string, max: number, label = path, opts: { noFollow?: boolean } = {}): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | (opts.noFollow ? fsc.O_NOFOLLOW : 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new CheckFailed([`${label} is a symbolic link, which is not allowed.`]);
    throw new CheckFailed([`${label} cannot be read (${code ?? (e as Error).message}).`]);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CheckFailed([`${label} is not a regular file.`]);
    if (st.size > max) throw new CheckFailed([`${label} is ${st.size} bytes, more than the limit of ${max} bytes.`]);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size) throw new CheckFailed([`${label} changed while it was read.`]);
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function readText(path: string, max: number, label = path, opts: { noFollow?: boolean } = {}): string {
  const buf = readCapped(path, max, label, opts);
  // Strict UTF-8: a decoder error is a problem, not a silent U+FFFD.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    throw new CheckFailed([`${label} is not valid UTF-8.`]);
  }
}

export function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    // The parser message can quote file content; it is neutralised on output.
    throw new CheckFailed([`${label} is not valid JSON: ${(e as Error).message.slice(0, 200)}`]);
  }
}

export function readJson(path: string, max: number, label = path, opts: { noFollow?: boolean } = {}): unknown {
  return parseJsonText(readText(path, max, label, opts), label);
}

/** Writes JSON as UTF-8 with 2-space indent and a trailing newline. */
export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Problems for keys that are missing or not in `keys` (exact key set). */
export function exactKeys(o: Record<string, unknown>, keys: string[], label: string): string[] {
  const problems: string[] = [];
  for (const k of keys) if (!Object.hasOwn(o, k)) problems.push(`${label} is missing "${k}".`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${label} has an unknown key "${k}".`);
  return problems;
}

/** realpath of `p`, or a CheckFailed when it does not exist. */
export function realOrFail(p: string, label: string): string {
  try {
    return realpathSync(p);
  } catch {
    throw new CheckFailed([`${label} does not exist.`]);
  }
}

/** True when the real path `child` is `root` itself or below it. Both must already be realpaths. */
export function isWithin(root: string, child: string): boolean {
  const r = relative(root, child);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep));
}

export function requireDir(p: string, label: string): string {
  const real = realOrFail(resolve(p), label);
  if (!lstatSync(real).isDirectory()) throw new CheckFailed([`${label} is not a directory.`]);
  return real;
}

// ------------------------------------------------------------------------------------------
// instance.yaml
// ------------------------------------------------------------------------------------------

export interface InstanceEnvironment {
  name: string;
  kind: "prod" | "nonprod";
  promoteFrom?: string;
  subscriptionId: string;
  region?: string;
  vaultGeneration?: number;
}

export interface InstanceData {
  coreVersion: string;
  defaultRegion: string;
  naming: { prefix: string };
  environments: InstanceEnvironment[];
  scanning?: {
    provider?: "trivy" | "defender";
    blockProdPromotionOn?: "none" | "critical" | "high";
    onlyWithAvailableFix?: boolean;
  };
  /** The portal API that delivery pipelines report deploys to (ADR-0037); both optional. */
  portal?: { clientId?: string; apiBaseUrl?: string };
}

/** Loads instance.yaml with the bundled schema (same validation as `platform validate instance`). */
export function loadInstance(path: string): InstanceData {
  const label = "instance.yaml";
  const text = readText(path, 4 * MiB, `${label} (${path})`);
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) {
    throw new CheckFailed(parsed.parseErrors.map((e) => `${label} line ${e.line}: YAML syntax error: ${e.message}`));
  }
  const problems = validateData("instance", parsed.data, parsed);
  if (problems.length) {
    throw new CheckFailed(problems.map((p) => `${label} ${p.line ? `line ${p.line}: ` : ""}${p.path}: ${p.message}.`));
  }
  const data = parsed.data as InstanceData;
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const e of data.environments) {
    if (seen.has(e.name)) dup.push(`${label}: environment name "${e.name}" is used more than once.`);
    seen.add(e.name);
  }
  if (dup.length) throw new CheckFailed(dup);
  return data;
}

// ------------------------------------------------------------------------------------------
// The `environments` template parameter: [{ name, kind, promoteFrom }]
// ------------------------------------------------------------------------------------------

export interface EnvParam {
  name: string;
  kind: "prod" | "nonprod";
  promoteFrom: string;
  /**
   * Delivery only (ADR-0053): the app's capacity reservation in the environment, rendered by
   * `platform generate` into delivery.yml. Absent in a delivery.yml generated before it.
   */
  capacity?: { size: "xs" | "s" | "m" | "l"; maxReplicas: number };
}

const CAPACITY_SIZE_VALUES = ["xs", "s", "m", "l"] as const;

/**
 * `opts.capacity`: the delivery pipeline's list, whose entries may carry `capacity: {size,
 * maxReplicas}` (ADR-0053); the provisioning pipeline's list has exactly name, kind and promoteFrom.
 */
export function parseEnvironmentsParam(value: unknown, label: string, opts: { capacity?: boolean } = {}): EnvParam[] {
  if (!Array.isArray(value)) throw new CheckFailed([`${label} must be a JSON array.`]);
  if (value.length === 0) throw new CheckFailed([`${label} must name at least one environment.`]);
  const problems: string[] = [];
  const out: EnvParam[] = [];
  const names = new Set<string>();
  value.forEach((e: unknown, i: number) => {
    const at = `${label}[${i}]`;
    if (!isObject(e)) {
      problems.push(`${at} must be an object.`);
      return;
    }
    const withCapacity = opts.capacity === true && Object.hasOwn(e, "capacity");
    const keyProblems = exactKeys(e, withCapacity ? ["name", "kind", "promoteFrom", "capacity"] : ["name", "kind", "promoteFrom"], at);
    problems.push(...keyProblems);
    const name = own(e, "name");
    const kind = own(e, "kind");
    const promoteFrom = own(e, "promoteFrom");
    let capacity: EnvParam["capacity"];
    if (withCapacity) {
      const c = own(e, "capacity");
      const size = isObject(c) ? own(c, "size") : undefined;
      // Azure Pipelines passes numbers of a template object as numbers; convertToJson keeps them.
      const max = isObject(c) ? own(c, "maxReplicas") : undefined;
      const maxN = typeof max === "string" && /^\d{1,2}$/.test(max) ? Number(max) : max;
      if (!isObject(c) || exactKeys(c, ["size", "maxReplicas"], `${at}.capacity`).length || !CAPACITY_SIZE_VALUES.includes(size as "s") || typeof maxN !== "number" || !Number.isInteger(maxN) || maxN < 1 || maxN > 10) {
        problems.push(`${at}.capacity must be {size: xs|s|m|l, maxReplicas: 1..10} (rendered by platform generate).`);
      } else {
        capacity = { size: size as "s", maxReplicas: maxN };
      }
    }
    if (typeof name !== "string" || !ENV_NAME_RE.test(name)) problems.push(`${at}.name must be an environment name (2-8 lowercase letters and digits).`);
    if (kind !== "prod" && kind !== "nonprod") problems.push(`${at}.kind must be "prod" or "nonprod".`);
    if (typeof promoteFrom !== "string" || (promoteFrom !== "" && !ENV_NAME_RE.test(promoteFrom))) {
      problems.push(`${at}.promoteFrom must be '' or an environment name.`);
    }
    if (typeof name === "string") {
      if (names.has(name)) problems.push(`${at}.name "${name}" is listed more than once.`);
      names.add(name);
    }
    if (!keyProblems.length && typeof name === "string" && (kind === "prod" || kind === "nonprod") && typeof promoteFrom === "string") {
      out.push({ name, kind, promoteFrom, ...(capacity ? { capacity } : {}) });
    }
  });
  if (problems.length) throw new CheckFailed(problems);
  return out;
}

export function envVar(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (v === undefined || v === "") throw new CheckFailed([`environment variable ${name} is not set.`]);
  return v;
}
