import { cellManagedEnvironmentName, cellPlatformJobName } from "../capacity.js";
import { CheckFailed } from "../pipeline/common.js";

/**
 * The names the provisioning plan needs for every app of an environment (ADR-0050): ported from
 * infra/modules/naming/naming.bicep with its input guards and length limits, so the jobs plan_<env>
 * name hundreds of apps without one `bicep snapshot` each. test/naming-vectors.test.ts compares
 * every function here with infra/tests/naming-vectors.json, which infra/tests/check-naming.py checks
 * against naming.bicep, so the two can't drift (as the portal's port, portal/shared/src/naming.ts).
 * Invalid input throws CheckFailed, as naming.bicep's fail() stops a deployment.
 */

const SHORT_TOKEN_RE = /^[a-z][a-z0-9]*$/;

function shortToken(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && SHORT_TOKEN_RE.test(value);
}

/** naming.bicep isSlug: 3-20 characters, a-z0-9 and single inner hyphens, not reserved. */
function isSlug(value: string): boolean {
  const shape = value.length >= 3 && value.length <= 20 && /^[a-z][a-z0-9-]*$/.test(value);
  const hyphens = !value.endsWith("-") && !value.includes("--");
  const reserved = ["platform", "portal"].includes(value) || value.includes("microsoft") || value.includes("windows");
  return shape && hyphens && !reserved;
}

function p(prefix: string): string {
  if (!shortToken(prefix, 2, 8)) throw new CheckFailed([`naming: invalid instance prefix "${prefix.slice(0, 20)}" (2-8 characters, ^[a-z][a-z0-9]{1,7}$, ADR-0020).`]);
  return prefix;
}

function e(env: string): string {
  if (!shortToken(env, 2, 8)) throw new CheckFailed([`naming: invalid environment name "${env.slice(0, 20)}" (2-8 characters, ^[a-z][a-z0-9]{1,7}$, ADR-0020).`]);
  return env;
}

function s(slug: string): string {
  if (!isSlug(slug)) throw new CheckFailed([`naming: invalid app slug "${slug.slice(0, 40)}" (3-20 characters, ^[a-z](-?[a-z0-9])+$, not platform/portal, no microsoft/windows, ADR-0020).`]);
  return slug;
}

function j(jobKey: string): string {
  if (!shortToken(jobKey, 2, 6)) throw new CheckFailed([`naming: invalid job key "${jobKey.slice(0, 20)}" (2-6 characters, ^[a-z][a-z0-9]{1,5}$, ADR-0020).`]);
  return jobKey;
}

function fit(limit: number, name: string): string {
  if (name.length > limit) throw new CheckFailed([`naming: "${name}" is ${name.length} characters, limit ${limit}.`]);
  return name;
}

export type NetworkMode = "externalOnly" | "externalHybrid";

function modeAbbreviation(mode: string): string {
  if (mode === "externalOnly") return "ext";
  if (mode === "externalHybrid") return "hyb";
  throw new CheckFailed([`naming: unknown network mode "${mode.slice(0, 20)}" (externalOnly | externalHybrid).`]);
}

/** rg-{prefix}-app-{slug}-{env} */
export const appResourceGroup = (prefix: string, slug: string, env: string): string => fit(90, `rg-${p(prefix)}-app-${s(slug)}-${e(env)}`);
/** ca-{slug} */
export const containerApp = (slug: string): string => fit(31, `ca-${s(slug)}`);
/** {slug}: the app's repository in its registry (delivery pushes there; the registry purge lists it, ADR-0059). */
export const registryRepository = (slug: string): string => s(slug);
/** lz-{slug}-{env}: the landing zone's deployment at subscription scope. */
export const provisioningDeployment = (slug: string, env: string): string => fit(64, `lz-${s(slug)}-${e(env)}`);
/** release-{slug}: the release's deployment in the app resource group. */
export const releaseDeployment = (slug: string): string => fit(64, `release-${s(slug)}`);
/** fd-{slug}-{env}: the custom domain's deployment in the platform resource group. */
export const frontDoorDeployment = (slug: string, env: string): string => fit(64, `fd-${s(slug)}-${e(env)}`);
/** entra-{slug}-{env}: the registration's deployment in rg-{prefix}-entra-{env} (ADR-0063; before it in rg-{prefix}-entra). */
export const entraDeployment = (slug: string, env: string): string => fit(64, `entra-${s(slug)}-${e(env)}`);
/** rg-{prefix}-entra: the instance's Entra deployments (entra-permissions, entra-portal-{env}, app records from before ADR-0063). */
export const entraResourceGroup = (prefix: string): string => fit(90, `rg-${p(prefix)}-entra`);
/** rg-{prefix}-entra-{env}: one environment's Entra registration records (ADR-0063), in the portal host's subscription. */
export const entraEnvironmentResourceGroup = (prefix: string, env: string): string => fit(90, `rg-${p(prefix)}-entra-${e(env)}`);
/** rg-{prefix}-platform-{env} */
export const platformResourceGroup = (prefix: string, env: string): string => fit(90, `rg-${p(prefix)}-platform-${e(env)}`);
/** platform-{prefix}-{env}: the environment's deployment of environment.bicep at subscription scope (ADR-0043). */
export const platformDeployment = (prefix: string, env: string): string => fit(64, `platform-${p(prefix)}-${e(env)}`);
/** portal-{prefix}-{env}: the portal's deployment of portal.bicep in the portal host's subscription (ADR-0036). */
export const portalDeployment = (prefix: string, env: string): string => fit(64, `portal-${p(prefix)}-${e(env)}`);
/** entra-portal-{env}: the portal registration's deployment in rg-{prefix}-entra (portal-registration.bicep). */
export const portalEntraDeployment = (env: string): string => fit(64, `entra-portal-${e(env)}`);
/** easyauth-{slug}: the Easy Auth secret in the environment vault. */
export const easyAuthSecret = (slug: string): string => fit(127, `easyauth-${s(slug)}`);
/**
 * cae-{prefix}-{ext|hyb}-{env}: the Container Apps environment of a network mode (cell 01, ADR-0053). The plan
 * matches a live app's environmentId against it to tell the mode the app runs in now (ADR-0060).
 */
export const managedEnvironment = (prefix: string, mode: string, env: string): string => fit(32, `cae-${p(prefix)}-${modeAbbreviation(mode)}-${e(env)}`);
/** caj-{prefix}-{step}-{ext|hyb}: a platform job of a CAE (kvset, dbinit; cell 01, ADR-0053). */
export const platformJob = (prefix: string, step: string, mode: string): string => fit(31, `caj-${p(prefix)}-${j(step)}-${modeAbbreviation(mode)}`);
/**
 * cae-{prefix}-{ext|hyb}-{env}[-c{cell}]: the CAE of a network mode in a capacity cell (ADR-0053; cell 01 =
 * managedEnvironment). The plan matches a live app's environmentId against every cell's to tell the mode
 * and the cell the app runs in now (ADR-0060). The port of naming.bicep cellManagedEnvironment is capacity.ts's.
 */
export const cellManagedEnvironment = (prefix: string, mode: string, env: string, cell: string): string => cellManagedEnvironmentName(prefix, mode, env, cell);
/** caj-{prefix}-{step}-{ext|hyb}[-c{cell}]: a platform job of a capacity cell's CAE (ADR-0053; cell 01 = platformJob). */
export const cellPlatformJob = (prefix: string, step: string, mode: string, cell: string): string => cellPlatformJobName(prefix, step, mode, cell);
/**
 * The Entra application's uniqueName (ADR-0061): {prefix}-{slug}-{env} for incarnation 0, with
 * --i{incarnation} above it. Entra keeps a uniqueName immutable and holds it for 30 days after a delete,
 * so a new app with a deleted app's slug (a higher app.yaml incarnation) gets its own. The stage entra
 * resolves the registration it deletes (entra-delete) or reconciles (entra-reconcile) by it.
 */
export const entraApplicationUniqueName = (prefix: string, slug: string, env: string, incarnation: number): string => {
  if (!Number.isSafeInteger(incarnation) || incarnation < 0) throw new CheckFailed([`naming: incarnation must be >= 0, got ${String(incarnation).slice(0, 20)}.`]);
  return incarnation === 0 ? `${p(prefix)}-${s(slug)}-${e(env)}` : `${p(prefix)}-${s(slug)}-${e(env)}--i${incarnation}`;
};

/** Shape of entraApplicationUniqueName: what entra-delete and entra-reconcile accept as --unique-name. */
export const ENTRA_UNIQUE_NAME_RE = /^[a-z][a-z0-9]{1,7}-[a-z](-?[a-z0-9])+-[a-z][a-z0-9]{1,7}(--i[1-9][0-9]{0,8})?$/;
