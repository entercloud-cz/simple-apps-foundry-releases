import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sizeIndex, withinReservation } from "../capacity.js";
import { consistencyProblems } from "../checks/manifest.js";
import type { ManifestData, ManifestRuntime } from "../context.js";
import { enforceFinding, todayUtc } from "../enforcement.js";
import { parseYaml, validateData } from "../schema.js";
import {
  CheckFailed,
  MiB,
  REF_RE,
  envVar,
  isWithin,
  loadInstance,
  parseEnvironmentsParam,
  parseJsonText,
  readText,
  realOrFail,
  requireDir,
  slugProblem,
} from "./common.js";
import type { EnvParam } from "./common.js";

/**
 * Loads an app's platform.yaml (untrusted): no symlink, at most 1 MiB, schema-valid and
 * PC003-consistent. With `appDirReal`, the file must also sit inside that directory.
 */
export function loadManifest(path: string, appDirReal?: string): ManifestData {
  const label = "platform.yaml";
  const abs = resolve(path);
  const text = readText(abs, 1 * MiB, label, { noFollow: true });
  if (appDirReal && !isWithin(appDirReal, realOrFail(abs, label))) {
    throw new CheckFailed([`${label} is outside the app directory.`]);
  }
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) {
    throw new CheckFailed(parsed.parseErrors.map((e) => `${label} line ${e.line}: YAML syntax error: ${e.message}`));
  }
  const problems = validateData("manifest", parsed.data, parsed);
  if (problems.length) {
    throw new CheckFailed(problems.map((p) => `${label} ${p.line ? `line ${p.line}: ` : ""}${p.path}: ${p.message}.`));
  }
  const data = parsed.data as ManifestData;
  const lineAt = (segs: (string | number)[]): number | undefined => {
    const node = parsed.doc.getIn(segs, true) as { range?: [number, number, number] } | null | undefined;
    return node && typeof node === "object" && node.range ? parsed.lc.linePos(node.range[0]).line : undefined;
  };
  const consistency = consistencyProblems(data, lineAt);
  if (consistency.length) {
    throw new CheckFailed(consistency.map((p) => `${label} ${p.line ? `line ${p.line}: ` : ""}${p.message}`));
  }
  return data;
}

// ------------------------------------------------------------------------------------------
// release-inputs
// ------------------------------------------------------------------------------------------

export interface ResolvedRuntime {
  port: number;
  size: "xs" | "s" | "m" | "l";
  minReplicas: number;
  maxReplicas: number;
  livenessPath: string;
  readinessPath: string;
}

export interface ResolvedEnvVar {
  name: string;
  value: string | null;
  secret: string | null;
}

export interface ReleaseInputs {
  slug: string;
  build: { dockerfile: string; context: string };
  deployBranches: string[];
  environments: Record<string, { runtime: ResolvedRuntime; env: ResolvedEnvVar[]; secrets: string[] }>;
  /**
   * Warnings of the checks that warn before they block (ADR-0049 section 7): the runtime above the
   * app's capacity reservation before enforceFrom (ADR-0053), or no reservation in delivery.yml.
   * release-manifest.sh turns a non-empty list into a warning of the run.
   */
  warnings: string[];
}

/** The pipeline check of the runtime against the capacity reservation (explanations.ts, rules.ts PIPELINE_CHECK_ENFORCE_FROM). */
export const CAPACITY_CHECK_ID = "capacity-reservation";

/**
 * platform.yaml's size and maxReplicas in each environment against the app's capacity reservation there
 * (ADR-0053), which `platform generate` renders into delivery.yml from app.yaml and instance.yaml: a
 * larger size or more replicas is refused, as a warning until the check's enforceFrom date. An
 * environment without a reservation (a delivery.yml generated before ADR-0053) is a warning.
 */
export function capacityFindings(
  envs: EnvParam[],
  environments: ReleaseInputs["environments"],
  labels: Record<string, string>,
  today: string = todayUtc(),
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const e of envs) {
    const resolved = environments[e.name];
    if (!resolved) continue;
    if (!e.capacity) {
      warnings.push(`environment ${e.name}: delivery.yml carries no capacity reservation (generated before ADR-0053), so the runtime wasn't checked; run \`platform generate\` in platform-config.`);
      continue;
    }
    const { size, maxReplicas } = resolved.runtime;
    if (withinReservation({ size, maxReplicas }, e.capacity)) continue;
    const over = [
      ...(sizeIndex(size) > sizeIndex(e.capacity.size) ? [`size ${size} is larger than ${e.capacity.size}`] : []),
      ...(maxReplicas > e.capacity.maxReplicas ? [`maxReplicas ${maxReplicas} is more than ${e.capacity.maxReplicas}`] : []),
    ].join(" and ");
    const f = enforceFinding(
      {
        ruleId: CAPACITY_CHECK_ID,
        group: "manifest",
        severity: "error",
        message: `platform.yaml ${labels[e.name] ?? "runtime"} in environment ${e.name}: ${over}, above the app's capacity reservation there (size ${e.capacity.size}, maxReplicas ${e.capacity.maxReplicas}; check ${CAPACITY_CHECK_ID})`,
        hint: "Lower runtime.size or runtime.scale.maxReplicas in platform.yaml, or ask for more capacity: in the portal, the app's page, More capacity (a pull request the platform team reviews).",
        aiPrompt: "",
      },
      today,
    );
    (f.severity === "error" ? errors : warnings).push(`${f.message}. ${f.hint}`);
  }
  return { errors, warnings };
}

/** Defaults: the schema and templates/app/platform.yaml.tmpl. */
export const RUNTIME_DEFAULTS = { port: 8080, size: "s" as const, minReplicas: 0, maxReplicas: 2, livenessPath: "/healthz" };

/**
 * Merges a per-environment override field by field over the top-level runtime (scale and health
 * sub-fields individually; an override `env` list replaces the whole list) and applies defaults.
 */
export function resolveRuntime(top: ManifestRuntime | undefined, override: ManifestRuntime | undefined, label: string): { runtime: ResolvedRuntime; env: ResolvedEnvVar[] } {
  const t = top ?? {};
  const o = override ?? {};
  const minReplicas = o.scale?.minReplicas ?? t.scale?.minReplicas ?? RUNTIME_DEFAULTS.minReplicas;
  const explicitMax = o.scale?.maxReplicas ?? t.scale?.maxReplicas;
  if (explicitMax !== undefined && minReplicas > explicitMax) {
    throw new CheckFailed([
      `platform.yaml ${label}: minReplicas (${minReplicas}) is greater than maxReplicas (${explicitMax}) after merging the environment override over runtime.`,
    ]);
  }
  const livenessPath = o.health?.liveness ?? t.health?.liveness ?? RUNTIME_DEFAULTS.livenessPath;
  const runtime: ResolvedRuntime = {
    port: o.port ?? t.port ?? RUNTIME_DEFAULTS.port,
    size: o.size ?? t.size ?? RUNTIME_DEFAULTS.size,
    minReplicas,
    maxReplicas: explicitMax ?? Math.max(RUNTIME_DEFAULTS.maxReplicas, minReplicas),
    livenessPath,
    readinessPath: o.health?.readiness ?? t.health?.readiness ?? livenessPath,
  };
  const list = o.env ?? t.env ?? [];
  const env = list
    .filter((e): e is NonNullable<typeof e> => Boolean(e))
    .map((e) => ({ name: e.name, value: e.value ?? null, secret: e.secret ?? null }));
  return { runtime, env };
}

/** Resolves a manifest-relative path inside the real app directory (symlinks followed). */
function insideApp(appDirReal: string, rel: string, label: string, kind: "file" | "dir"): string {
  if (isAbsolute(rel)) throw new CheckFailed([`platform.yaml ${label} "${rel}" must be a relative path.`]);
  const real = realOrFail(resolve(appDirReal, rel), `platform.yaml ${label} "${rel}"`);
  if (!isWithin(appDirReal, real)) throw new CheckFailed([`platform.yaml ${label} "${rel}" resolves outside the app directory.`]);
  const st = statSync(real);
  if (kind === "file" && !st.isFile()) throw new CheckFailed([`platform.yaml ${label} "${rel}" is not a file.`]);
  if (kind === "dir" && !st.isDirectory()) throw new CheckFailed([`platform.yaml ${label} "${rel}" is not a directory.`]);
  return real;
}

export function releaseInputs(args: { manifest: string; appDir: string; slug: string; environments: string; instance: string; today?: string }): ReleaseInputs {
  const sp = slugProblem(args.slug, "--slug");
  if (sp) throw new CheckFailed([sp]);
  const instance = loadInstance(args.instance);
  const instanceNames = instance.environments.map((e) => e.name);
  const envs: EnvParam[] = parseEnvironmentsParam(parseJsonText(args.environments, "--environments"), "--environments", { capacity: true });
  const notInInstance = envs.filter((e) => !instanceNames.includes(e.name));
  if (notInInstance.length) {
    throw new CheckFailed(notInInstance.map((e) => `--environments: "${e.name}" is not an environment of this instance (${instanceNames.join(", ")}).`));
  }
  const appDirReal = requireDir(args.appDir, "--app-dir");
  const data = loadManifest(args.manifest, appDirReal);

  const problems: string[] = [];
  if (data.app !== args.slug) problems.push(`platform.yaml app "${data.app ?? ""}" does not match the registered app "${args.slug}".`);
  // Override keys must name instance environments (typos fail); --environments only selects
  // which environments appear in the output.
  for (const key of Object.keys(data.environments ?? {})) {
    if (!instanceNames.includes(key)) {
      problems.push(`platform.yaml environments.${key}: there is no environment "${key}" on this platform (environments: ${instanceNames.join(", ")}).`);
    }
  }
  if (problems.length) throw new CheckFailed(problems);

  const dockerfile = insideApp(appDirReal, data.build?.dockerfile || "Dockerfile", "build.dockerfile", "file");
  const context = insideApp(appDirReal, data.build?.context || ".", "build.context", "dir");

  const environments: ReleaseInputs["environments"] = {};
  const labels: Record<string, string> = {};
  for (const e of envs) {
    const override = data.environments && Object.hasOwn(data.environments, e.name) ? data.environments[e.name] : undefined;
    labels[e.name] = override ? `environments.${e.name}` : "runtime";
    const { runtime, env } = resolveRuntime(data.runtime, override, labels[e.name]!);
    environments[e.name] = { runtime, env, secrets: [...(data.secrets ?? [])] };
  }
  const capacity = capacityFindings(envs, environments, labels, args.today);
  if (capacity.errors.length) throw new CheckFailed(capacity.errors);
  return {
    slug: args.slug,
    build: { dockerfile, context },
    deployBranches: [...(data.deploy?.branches ?? ["*"])],
    environments,
    warnings: capacity.warnings,
  };
}

// ------------------------------------------------------------------------------------------
// deploy-branch
// ------------------------------------------------------------------------------------------

/** `*` = any sequence (including `/`), `?` = exactly one character, everything else literal; full match. */
export function branchGlobToRegExp(glob: string): RegExp {
  let re = "";
  for (const c of glob) {
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "u");
}

export function branchMatches(globs: string[], branch: string): boolean {
  return globs.some((g) => branchGlobToRegExp(g).test(branch));
}

/**
 * `promote-branch`: true iff the app ref of this run is exactly the app's default branch. Only
 * builds of the default branch are promoted (prod receives nothing else).
 */
export function promoteBranch(args: { defaultBranch: string }, env: NodeJS.ProcessEnv): boolean {
  if (!args.defaultBranch.startsWith("refs/heads/") || args.defaultBranch === "refs/heads/" || !REF_RE.test(args.defaultBranch)) {
    throw new CheckFailed(['--default-branch must be a branch ref starting with "refs/heads/".']);
  }
  const ref = envVar("RESOURCES_REPOSITORIES_APP_REF", env);
  if (!ref.startsWith("refs/heads/") || !REF_RE.test(ref)) return false;
  return ref === args.defaultBranch;
}

export function deployBranch(args: { manifest: string }, env: NodeJS.ProcessEnv): boolean {
  const ref = envVar("RESOURCES_REPOSITORIES_APP_REF", env);
  const data = loadManifest(args.manifest);
  if (!ref.startsWith("refs/heads/") || !REF_RE.test(ref)) return false;
  const branch = ref.slice("refs/heads/".length);
  if (!branch) return false;
  return branchMatches(data.deploy?.branches ?? ["*"], branch);
}
