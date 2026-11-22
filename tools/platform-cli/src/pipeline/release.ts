import { CELL_ID_RE } from "../capacity.js";
import { toolVersion } from "../run.js";
import {
  CORE_VERSION_RE,
  COMMIT_RE,
  CheckFailed,
  DIGEST_RE,
  ENV_NAME_RE,
  MiB,
  REF_RE,
  exactKeys,
  isObject,
  own,
  readJson,
  slugProblem,
} from "./common.js";
import type { InstanceEnvOutput } from "./instance.js";
import { parseTimestamp } from "./scan.js";

// ------------------------------------------------------------------------------------------
// release-manifest
// ------------------------------------------------------------------------------------------

export interface ReleaseManifest {
  schemaVersion: 1;
  slug: string;
  runId: number;
  commit: string;
  appRef: string;
  digest: string;
  tag: string;
  verdict: Record<string, unknown>;
  dbUpdatedAt: string;
  coreVersion: string;
  cliVersion: string;
  releaseInputs: Record<string, unknown>;
}

function checkReleaseInputsShape(ri: unknown, label: string): Record<string, unknown> {
  if (!isObject(ri)) throw new CheckFailed([`${label} must be a JSON object.`]);
  // `warnings` (ADR-0053): release-inputs of this core version; earlier ones have none.
  const problems = exactKeys(ri, Object.hasOwn(ri, "warnings") ? ["slug", "build", "deployBranches", "environments", "warnings"] : ["slug", "build", "deployBranches", "environments"], label);
  const warnings = own(ri, "warnings");
  if (warnings !== undefined && (!Array.isArray(warnings) || !warnings.every((w) => typeof w === "string"))) problems.push(`${label} warnings must be a list of strings.`);
  const sp = slugProblem(own(ri, "slug"), `${label} slug`);
  if (sp) problems.push(sp);
  if (!isObject(own(ri, "build"))) problems.push(`${label} build must be an object.`);
  if (!Array.isArray(own(ri, "deployBranches"))) problems.push(`${label} deployBranches must be a list.`);
  const envs = own(ri, "environments");
  if (!isObject(envs) || Object.keys(envs).length === 0) problems.push(`${label} environments must be a non-empty object.`);
  if (problems.length) throw new CheckFailed(problems);
  return ri;
}

export function releaseManifest(
  args: { digest: string; releaseInputs: string; verdict: string; trivyDbMetadata: string; coreVersion: string },
  env: NodeJS.ProcessEnv,
): ReleaseManifest {
  const problems: string[] = [];
  if (!DIGEST_RE.test(args.digest)) problems.push("--digest must be sha256:<64 lowercase hex>.");
  if (!CORE_VERSION_RE.test(args.coreVersion)) problems.push("--core-version must look like v1.2.3.");
  const commit = env.RESOURCES_REPOSITORIES_APP_VERSION ?? "";
  if (!COMMIT_RE.test(commit)) problems.push("RESOURCES_REPOSITORIES_APP_VERSION must be a 40-character lowercase commit SHA.");
  const appRef = env.RESOURCES_REPOSITORIES_APP_REF ?? "";
  if (!REF_RE.test(appRef) || appRef.length > 1024) problems.push("RESOURCES_REPOSITORIES_APP_REF must be a git ref (refs/...).");
  const buildId = env.BUILD_BUILDID ?? "";
  if (!/^[0-9]{1,15}$/.test(buildId)) problems.push("BUILD_BUILDID must be a number.");
  if (problems.length) throw new CheckFailed(problems);

  const releaseInputs = checkReleaseInputsShape(readJson(args.releaseInputs, 16 * MiB, "release inputs"), "release inputs");

  const verdict = readJson(args.verdict, 64 * MiB, "scan verdict");
  if (!isObject(verdict)) throw new CheckFailed(["scan verdict must be a JSON object."]);
  const provider = own(verdict, "provider");
  const pass = own(verdict, "pass");
  if ((provider !== "trivy" && provider !== "defender") || !(pass === true || pass === false || pass === null)) {
    throw new CheckFailed(["scan verdict is not a scan-gate verdict (provider, pass)."]);
  }

  const meta = readJson(args.trivyDbMetadata, 64 * 1024, "Trivy DB metadata");
  const dbUpdatedAt = isObject(meta) ? own(meta, "UpdatedAt") : undefined;
  if (parseTimestamp(dbUpdatedAt) === undefined) throw new CheckFailed(["Trivy DB metadata has no valid UpdatedAt."]);

  return {
    schemaVersion: 1,
    slug: own(releaseInputs, "slug") as string,
    runId: Number(buildId),
    commit,
    appRef,
    digest: args.digest,
    tag: commit,
    verdict,
    dbUpdatedAt: dbUpdatedAt as string,
    coreVersion: args.coreVersion,
    cliVersion: toolVersion(),
    releaseInputs,
  };
}

// ------------------------------------------------------------------------------------------
// release-params
// ------------------------------------------------------------------------------------------

/** Keys of release.bicep that provisioning owns: copied unchanged from the last release-<slug> deployment. */
export const PLATFORM_OWNED = [
  "generation",
  "vaultGeneration",
  "location",
  "networkMode",
  "externalOnlyNetwork",
  "landingZone",
  "frontDoor",
  "customDomains",
  "authentication",
] as const;

/**
 * release.bicep `cell` (ADR-0053), provisioning-owned like PLATFORM_OWNED, but a record written before
 * the parameter existed has none: every app ran in cell 01 then, so its absence means 01.
 */
export const RECORD_CELL_DEFAULT = "01";

export interface ReleaseParams {
  prefix: string;
  environmentName: string;
  slug: string;
  generation: number;
  vaultGeneration: number;
  location: string;
  networkMode: string;
  /** The capacity cell from the record (RECORD_CELL_DEFAULT for a record without it). */
  cell: string;
  externalOnlyNetwork: unknown;
  image: { digest: string };
  runtime: unknown;
  env: unknown;
  secrets: unknown;
  landingZone: unknown;
  frontDoor: unknown;
  customDomains: unknown;
  authentication: unknown;
  /** Build run that produced the image; release.bicep writes it to the tags saf-run-id and saf-commit. */
  run: { id: string; commit: string };
  /**
   * The core version this run runs (instance.yaml coreVersion, from instance-env; not the release
   * manifest's, which is the build's): release.bicep writes it to the Container App's tag saf-core
   * (ADR-0049 section 7). A redeploy of an older build applies this core's template too.
   */
  coreVersion: string;
}

/** Reads `{ "<param>": { "value": ... } }` (the ARM shape of properties.parameters). */
function recordValue(record: Record<string, unknown>, name: string, problems: string[]): unknown {
  const entry = own(record, name);
  if (!isObject(entry) || !Object.hasOwn(entry, "value")) {
    problems.push(`deployment record has no parameter "${name}" (expected { "value": ... }).`);
    return undefined;
  }
  const extra = Object.keys(entry).filter((k) => k !== "value" && k !== "type");
  if (extra.length) problems.push(`deployment record parameter "${name}" has unexpected keys: ${extra.join(", ")}.`);
  return entry.value;
}

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function checkEnvJson(v: unknown): InstanceEnvOutput {
  if (!isObject(v)) throw new CheckFailed(["environment file must be a JSON object (output of instance-env)."]);
  const problems = exactKeys(v, ["prefix", "name", "kind", "subscriptionId", "region", "promoteFrom", "vaultGeneration", "coreVersion"], "environment file");
  if (typeof own(v, "coreVersion") !== "string" || !CORE_VERSION_RE.test(own(v, "coreVersion") as string)) problems.push("environment file coreVersion must look like v1.2.3.");
  if (typeof own(v, "prefix") !== "string" || !/^[a-z][a-z0-9]{1,7}$/.test(own(v, "prefix") as string)) problems.push("environment file prefix is invalid.");
  if (typeof own(v, "name") !== "string" || !ENV_NAME_RE.test(own(v, "name") as string)) problems.push("environment file name is invalid.");
  if (problems.length) throw new CheckFailed(problems);
  return v as unknown as InstanceEnvOutput;
}

function checkAppOwned(e: unknown, envName: string): { runtime: Record<string, unknown>; env: unknown[]; secrets: string[] } {
  const label = `release manifest releaseInputs.environments.${envName}`;
  if (!isObject(e)) throw new CheckFailed([`${label} is missing: this build has no release inputs for environment "${envName}".`]);
  const problems = exactKeys(e, ["runtime", "env", "secrets"], label);
  const runtime = own(e, "runtime");
  if (!isObject(runtime)) problems.push(`${label}.runtime must be an object.`);
  else {
    problems.push(...exactKeys(runtime, ["port", "size", "minReplicas", "maxReplicas", "livenessPath", "readinessPath"], `${label}.runtime`));
    for (const k of ["port", "minReplicas", "maxReplicas"]) if (!isNonNegInt(own(runtime, k))) problems.push(`${label}.runtime.${k} must be an integer.`);
    for (const k of ["size", "livenessPath", "readinessPath"]) if (typeof own(runtime, k) !== "string") problems.push(`${label}.runtime.${k} must be a string.`);
  }
  const env = own(e, "env");
  if (!Array.isArray(env)) problems.push(`${label}.env must be a list.`);
  else {
    env.forEach((x: unknown, i: number) => {
      if (!isObject(x)) return problems.push(`${label}.env[${i}] must be an object.`);
      problems.push(...exactKeys(x, ["name", "value", "secret"], `${label}.env[${i}]`));
      const value = own(x, "value");
      const secret = own(x, "secret");
      if (typeof own(x, "name") !== "string") problems.push(`${label}.env[${i}].name must be a string.`);
      const ok = (typeof value === "string" && secret === null) || (value === null && typeof secret === "string");
      if (!ok) problems.push(`${label}.env[${i}] needs exactly one of value and secret (the other null).`);
      return undefined;
    });
  }
  const secrets = own(e, "secrets");
  if (!Array.isArray(secrets) || secrets.some((s) => typeof s !== "string")) problems.push(`${label}.secrets must be a list of names.`);
  if (problems.length) throw new CheckFailed(problems);
  return { runtime: runtime as Record<string, unknown>, env: env as unknown[], secrets: secrets as string[] };
}

export function releaseParams(args: { record: string; manifest: string; env: string }): ReleaseParams {
  const envJson = checkEnvJson(readJson(args.env, 64 * 1024, "environment file"));

  const manifest = readJson(args.manifest, 16 * MiB, "release manifest");
  if (!isObject(manifest) || own(manifest, "schemaVersion") !== 1) throw new CheckFailed(["release manifest must be a JSON object with schemaVersion 1."]);
  const slug = own(manifest, "slug");
  const digest = own(manifest, "digest");
  const problems: string[] = [];
  const sp = slugProblem(slug, "release manifest slug");
  if (sp) problems.push(sp);
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) problems.push("release manifest digest must be sha256:<64 lowercase hex>.");
  const runId = own(manifest, "runId");
  const commit = own(manifest, "commit");
  if (!isNonNegInt(runId)) problems.push("release manifest runId must be a non-negative integer.");
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) problems.push("release manifest commit must be a 40-character lowercase commit SHA.");
  const ri = own(manifest, "releaseInputs");
  if (!isObject(ri) || own(ri, "slug") !== slug) problems.push("release manifest releaseInputs.slug does not match its slug.");
  if (problems.length) throw new CheckFailed(problems);
  const envs = own(ri as Record<string, unknown>, "environments");
  const appOwned = checkAppOwned(isObject(envs) ? own(envs, envJson.name) : undefined, envJson.name);

  const record = readJson(args.record, 4 * MiB, "deployment record");
  if (!isObject(record)) throw new CheckFailed(["deployment record must be a JSON object (az deployment group show --query properties.parameters)."]);
  const rp: string[] = [];
  const rPrefix = recordValue(record, "prefix", rp);
  const rEnv = recordValue(record, "environmentName", rp);
  const rSlug = recordValue(record, "slug", rp);
  const owned: Record<string, unknown> = {};
  for (const k of PLATFORM_OWNED) owned[k] = recordValue(record, k, rp);
  const cell = Object.hasOwn(record, "cell") ? recordValue(record, "cell", rp) : RECORD_CELL_DEFAULT;
  if (rp.length) throw new CheckFailed(rp);

  if (rPrefix !== envJson.prefix) problems.push(`deployment record prefix "${String(rPrefix)}" does not match the environment's prefix "${envJson.prefix}".`);
  if (rEnv !== envJson.name) problems.push(`deployment record environmentName "${String(rEnv)}" does not match the environment "${envJson.name}".`);
  if (rSlug !== slug) problems.push(`deployment record slug "${String(rSlug)}" does not match the release manifest slug "${String(slug)}".`);
  if (!isNonNegInt(owned.generation)) problems.push("deployment record generation must be a non-negative integer.");
  if (!isNonNegInt(owned.vaultGeneration)) problems.push("deployment record vaultGeneration must be a non-negative integer.");
  if (typeof owned.location !== "string" || !owned.location) problems.push("deployment record location must be a non-empty string.");
  if (typeof owned.networkMode !== "string") problems.push("deployment record networkMode must be a string.");
  if (typeof cell !== "string" || !CELL_ID_RE.test(cell)) problems.push("deployment record cell must be two digits, 01 to 99 (ADR-0053).");
  for (const k of ["landingZone", "frontDoor", "authentication"] as const) if (!isObject(owned[k])) problems.push(`deployment record ${k} must be an object.`);
  if (!Array.isArray(owned.customDomains)) problems.push("deployment record customDomains must be a list.");
  if (problems.length) throw new CheckFailed(problems);

  return {
    prefix: envJson.prefix,
    environmentName: envJson.name,
    slug: slug as string,
    generation: owned.generation as number,
    vaultGeneration: owned.vaultGeneration as number,
    location: owned.location as string,
    networkMode: owned.networkMode as string,
    cell: cell as string,
    externalOnlyNetwork: owned.externalOnlyNetwork,
    image: { digest: digest as string },
    runtime: appOwned.runtime,
    env: appOwned.env,
    secrets: appOwned.secrets,
    landingZone: owned.landingZone,
    frontDoor: owned.frontDoor,
    customDomains: owned.customDomains,
    authentication: owned.authentication,
    run: { id: String(runId), commit: commit as string },
    coreVersion: envJson.coreVersion,
  };
}
