import type { Context } from "../context.js";
import { finding } from "../rules.js";
import type { CheckResult, Finding } from "../types.js";

export interface Instruction {
  keyword: string;
  args: string;
  line: number;
}

export interface Stage {
  image: string;
  alias?: string;
  line: number;
  instructions: Instruction[];
}

export interface ParsedDockerfile {
  globalArgs: Map<string, string | undefined>;
  stages: Stage[];
}

/** Joins continuation lines, drops comments, and returns one entry per instruction. */
export function tokenizeDockerfile(text: string): Instruction[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const out: Instruction[] = [];
  let escape = "\\";
  let i = 0;
  // Parser directives live at the very top.
  while (i < lines.length) {
    const m = /^\s*#\s*(escape)\s*=\s*(\S)\s*$/i.exec(lines[i] ?? "");
    if (m && m[2]) {
      escape = m[2];
      i++;
    } else if (/^\s*#\s*[a-z]+\s*=/i.test(lines[i] ?? "")) {
      i++;
    } else break;
  }
  for (; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const startLine = i + 1;
    let joined = raw;
    for (;;) {
      const t = joined.trimEnd();
      if (!t.endsWith(escape) || i + 1 >= lines.length) break;
      joined = t.slice(0, -1);
      i++;
      // comment and blank lines inside a continuation are dropped
      while (i + 1 < lines.length && ((lines[i] ?? "").trim() === "" || (lines[i] ?? "").trim().startsWith("#"))) i++;
      joined += " " + (lines[i] ?? "");
    }
    joined = joined.trim();
    const sp = /\s/.exec(joined);
    const keyword = (sp ? joined.slice(0, sp.index) : joined).toUpperCase();
    const args = sp ? joined.slice(sp.index).trim() : "";
    out.push({ keyword, args, line: startLine });
  }
  return out;
}

function parseArg(args: string): [string, string | undefined] | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(args.split(/\s+/)[0] ?? "");
  if (!m || !m[1]) return undefined;
  const v = m[2];
  return [m[1], v === undefined ? undefined : v.replace(/^["']|["']$/g, "")];
}

export function parseDockerfile(text: string): ParsedDockerfile {
  const globalArgs = new Map<string, string | undefined>();
  const stages: Stage[] = [];
  for (const ins of tokenizeDockerfile(text)) {
    if (ins.keyword === "FROM") {
      const tokens = ins.args.split(/\s+/).filter((t) => !t.startsWith("--"));
      const image = tokens[0] ?? "";
      const asIdx = tokens.findIndex((t) => t.toUpperCase() === "AS");
      const alias = asIdx > 0 ? tokens[asIdx + 1] : undefined;
      stages.push({ image, ...(alias ? { alias } : {}), line: ins.line, instructions: [] });
    } else if (stages.length === 0) {
      if (ins.keyword === "ARG") {
        const a = parseArg(ins.args);
        if (a) globalArgs.set(a[0], a[1]);
      }
    } else {
      stages[stages.length - 1]?.instructions.push(ins);
    }
  }
  return { globalArgs, stages };
}

/** Expands $VAR, ${VAR} and ${VAR:-default}. Returns undefined when a variable has no value. */
export function expand(value: string, vars: Map<string, string | undefined>): string | undefined {
  let unresolved = false;
  const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, def: string | undefined, b: string | undefined) => {
    const name = (a ?? b) as string;
    const v = vars.get(name);
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    unresolved = true;
    return "";
  });
  return unresolved ? undefined : result;
}

export interface ImageRef {
  name: string;
  tag?: string;
  digest?: string;
}

export function parseImageRef(ref: string): ImageRef {
  let rest = ref;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  let tag: string | undefined;
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { name: rest, ...(tag !== undefined ? { tag } : {}), ...(digest !== undefined ? { digest } : {}) };
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const EXACT_VERSION_RE = /(?:^|[^0-9.])v?\d+\.\d+\.\d+(?:[^0-9]|$)/;

export type PinVerdict = { ok: true } | { ok: false; reason: string };

export function pinVerdict(ref: ImageRef): PinVerdict {
  if (ref.digest !== undefined) {
    return DIGEST_RE.test(ref.digest) ? { ok: true } : { ok: false, reason: `the digest "${ref.digest}" is not a valid sha256 digest` };
  }
  if (ref.tag === undefined) return { ok: false, reason: "it has no tag (defaults to :latest)" };
  if (ref.tag.toLowerCase() === "latest") return { ok: false, reason: "it uses the floating tag :latest" };
  if (EXACT_VERSION_RE.test(ref.tag)) return { ok: true };
  if (/^v?\d+(?:-|$)/.test(ref.tag)) {
    return { ok: false, reason: `the tag :${ref.tag} only names a major version and moves with every release` };
  }
  if (/^v?\d+\.\d+(?:[^0-9.]|$)/.test(ref.tag)) {
    return { ok: false, reason: `the tag :${ref.tag} does not name an exact version (needs x.y.z)` };
  }
  return { ok: false, reason: `the tag :${ref.tag} is a floating name, not an exact version` };
}

function isRootUser(user: string): boolean {
  const u = user.split(":")[0]?.replace(/^["']|["']$/g, "").trim().toLowerCase();
  return u === "root" || u === "0";
}

function effectiveUser(stages: Stage[], index: number, depth = 0): { user?: string; line?: number } {
  const stage = stages[index];
  if (!stage || depth > 10) return {};
  const users = stage.instructions.filter((i) => i.keyword === "USER");
  const last = users[users.length - 1];
  if (last) return { user: last.args.split(/\s+/)[0] ?? "", line: last.line };
  const baseIdx = stages.findIndex((s, i) => i < index && s.alias !== undefined && s.alias.toLowerCase() === stage.image.toLowerCase());
  if (baseIdx >= 0) return effectiveUser(stages, baseIdx, depth + 1);
  return {};
}

function parseVarPairs(keyword: string, args: string): [string, string | undefined][] {
  if (keyword === "ENV" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) {
    // legacy form: ENV KEY value with spaces
    const m = /^(\S+)\s+(.*)$/.exec(args);
    return m && m[1] ? [[m[1], (m[2] ?? "").replace(/^["']|["']$/g, "")]] : [];
  }
  const out: [string, string | undefined][] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)(?:=("[^"]*"|'[^']*'|\S*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    out.push([m[1] as string, m[2] === undefined ? undefined : m[2].replace(/^["']|["']$/g, "")]);
    if (keyword === "ARG") break;
  }
  return out;
}

export function checkDockerfile(ctx: Context): CheckResult {
  const findings: Finding[] = [];
  const rel = ctx.dockerfileRel;
  const ctxRel = ctx.buildContextRel;

  const missing = (message: string, hint: string): CheckResult => ({
    group: "dockerfile",
    findings: [
      finding("PC010", {
        message,
        file: rel,
        hint,
        aiPrompt: `${message} Create or fix the Dockerfile (or the build.dockerfile / build.context settings in platform.yaml) following the app-contract-and-docker skill, then run "platform check".`,
      }),
    ],
  });

  if (!ctx.isInside(rel) || !ctx.isInside(ctxRel)) {
    return missing(
      `build.dockerfile ("${rel}") and build.context ("${ctxRel}") must stay inside the repository.`,
      "Use paths inside the repository (no '..' and no absolute paths).",
    );
  }
  const text = ctx.readText(rel);
  if (text === undefined) {
    return missing(`Dockerfile "${rel}" not found.`, "Add a Dockerfile (the path comes from build.dockerfile in platform.yaml, default: Dockerfile).");
  }

  const parsed = parseDockerfile(text);
  if (parsed.stages.length === 0) {
    return missing(`Dockerfile "${rel}" has no FROM instruction.`, "A Dockerfile must start with FROM <image>.");
  }

  // PC011: every FROM pinned.
  const seenAliases = new Set<string>();
  parsed.stages.forEach((stage) => {
    const resolved = expand(stage.image, parsed.globalArgs);
    const isInternal = seenAliases.has(stage.image.toLowerCase());
    if (stage.alias) seenAliases.add(stage.alias.toLowerCase());
    if (isInternal || stage.image.toLowerCase() === "scratch") return;
    if (resolved === undefined) {
      findings.push(
        finding("PC011", {
          message: `FROM ${stage.image}: the image cannot be resolved because a build argument has no default, so the pin cannot be verified.`,
          file: rel,
          line: stage.line,
          hint: "Give the ARG a default value that is an exact version, or write the exact image in FROM.",
          aiPrompt: `In ${rel} line ${stage.line}, "FROM ${stage.image}" uses an ARG without a default. Give the ARG an exact-version default (x.y.z or @sha256 digest), then run "platform check".`,
          fingerprintSeed: `from-unresolved|${stage.image}`,
        }),
      );
      return;
    }
    const verdict = pinVerdict(parseImageRef(resolved));
    if (!verdict.ok) {
      findings.push(
        finding("PC011", {
          message: `FROM ${resolved}: ${verdict.reason}.`,
          file: rel,
          line: stage.line,
          hint: "Pin the base image to an exact version such as node:22.11.0-alpine3.20, or to a sha256 digest, so builds are repeatable and reviewable.",
          aiPrompt: `In ${rel} line ${stage.line}, "FROM ${resolved}" is not pinned (${verdict.reason}). Replace it with the same image pinned to an exact x.y.z tag (and optionally @sha256:<digest>), keeping the flavour (alpine/slim/...). Then run "platform check".`,
          fingerprintSeed: `from|${resolved}`,
        }),
      );
    }
  });

  // PC012: non-root final stage.
  const finalIdx = parsed.stages.length - 1;
  const finalStage = parsed.stages[finalIdx] as Stage;
  const eff = effectiveUser(parsed.stages, finalIdx);
  if (eff.user === undefined) {
    findings.push(
      finding("PC012", {
        message: "The final stage has no USER instruction, so the container would run as root.",
        file: rel,
        line: finalStage.line,
        hint: "Add a USER line near the end of the Dockerfile that switches to an unprivileged user, e.g. USER node or USER 10001.",
        aiPrompt: `The final stage of ${rel} has no USER instruction. Add a non-root USER (create a user and chown the app files if needed) just before CMD/ENTRYPOINT, then run "platform check".`,
      }),
    );
  } else if (isRootUser(eff.user)) {
    findings.push(
      finding("PC012", {
        message: `The final stage runs as root (USER ${eff.user}).`,
        file: rel,
        ...(eff.line !== undefined ? { line: eff.line } : {}),
        hint: "Switch to an unprivileged user in the last stage, e.g. USER node or USER 10001.",
        aiPrompt: `${rel} line ${eff.line ?? "?"} sets USER ${eff.user} in the final stage. Change the final stage to run as a non-root user (create it and fix file ownership if needed), then run "platform check".`,
      }),
    );
  }

  // PC013 / PC014: port consistency (final stage only).
  const expected = ctx.port;
  const vars = new Map<string, string | undefined>(parsed.globalArgs);
  vars.set("PORT", String(expected));
  const exposed: { port: number; line: number }[] = [];
  let envPortSeen: { value: string; line: number } | undefined;
  let exposeUnresolved = false;
  for (const ins of finalStage.instructions) {
    if (ins.keyword === "ARG" || ins.keyword === "ENV") {
      const pairs = parseVarPairs(ins.keyword, ins.args);
      for (const pair of pairs) {
        const [k, v] = pair;
        if (ins.keyword === "ENV" && k === "PORT" && v !== undefined) envPortSeen = { value: v, line: ins.line };
        if (ins.keyword === "ENV" || !vars.has(k)) vars.set(k, v);
      }
    } else if (ins.keyword === "EXPOSE") {
      for (const tok of ins.args.split(/\s+/).filter(Boolean)) {
        const r = expand(tok, vars);
        const m = r === undefined ? null : /^(\d+)(?:-(\d+))?(?:\/(tcp|udp))?$/i.exec(r);
        if (!m || !m[1]) {
          exposeUnresolved = true;
          continue;
        }
        const lo = Number(m[1]);
        const hi = m[2] ? Number(m[2]) : lo;
        if (expected >= lo && expected <= hi) exposed.push({ port: expected, line: ins.line });
        else exposed.push({ port: lo, line: ins.line });
      }
    }
  }
  if (envPortSeen) {
    const v = expand(envPortSeen.value, vars);
    if (v !== undefined && /^\d+$/.test(v) && Number(v) !== expected) {
      findings.push(
        finding("PC013", {
          message: `ENV PORT=${v} in the Dockerfile differs from runtime.port (${expected}) in platform.yaml. The platform injects PORT itself.`,
          file: rel,
          line: envPortSeen.line,
          hint: `Remove the ENV PORT line, or make platform.yaml runtime.port the same number (${v}).`,
          aiPrompt: `${rel} line ${envPortSeen.line} sets ENV PORT=${v} but platform.yaml runtime.port is ${expected}. Make them consistent (prefer removing ENV PORT and letting the app read $PORT, default ${expected}), then run "platform check".`,
        }),
      );
    }
  }
  const exposeLines = exposed.filter((e) => e.port !== expected);
  if (exposed.length > 0 && !exposed.some((e) => e.port === expected)) {
    findings.push(
      finding("PC013", {
        message: `EXPOSE ${exposed.map((e) => e.port).join(", ")} does not include runtime.port (${expected}) from platform.yaml.`,
        file: rel,
        line: exposeLines[0]?.line ?? exposed[0]?.line ?? 1,
        hint: `Make EXPOSE and runtime.port in platform.yaml the same number (${expected}).`,
        aiPrompt: `${rel} exposes port(s) ${exposed.map((e) => e.port).join(", ")} but platform.yaml runtime.port is ${expected}. Make them consistent and make sure the app listens on $PORT, then run "platform check".`,
      }),
    );
  } else if (exposed.length === 0 && !exposeUnresolved && !envPortSeen) {
    findings.push(
      finding("PC014", {
        message: `No EXPOSE ${expected} in the final stage.`,
        file: rel,
        line: finalStage.line,
        hint: `Add "EXPOSE ${expected}" to the Dockerfile so the port is documented.`,
        aiPrompt: `Add "EXPOSE ${expected}" (the runtime.port from platform.yaml) to the final stage of ${rel}, then run "platform check".`,
      }),
    );
  }

  return { group: "dockerfile", findings };
}
