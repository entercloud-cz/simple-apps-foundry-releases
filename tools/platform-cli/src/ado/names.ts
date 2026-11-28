/**
 * Azure DevOps object names, the same as infra/modules/naming/naming.bicep (adoServiceConnection,
 * adoEnvironment, adoDeliveryPipeline). test/ado.test.ts compares them with that file, so the two
 * cannot drift. Slug and environment name are validated before they get here.
 */
export const adoServiceConnection = (slug: string, env: string): string => `sc-${slug}-${env}`;
export const adoEnvironment = (slug: string, env: string): string => `${slug}-${env}`;
export const adoDeliveryPipeline = (slug: string): string => `delivery-${slug}`;
/** Folder of the generated delivery pipelines. */
export const DELIVERY_FOLDER = "\\apps";
/** Ownership marker of retention leases and descriptions written by the platform. */
export const MANAGED_NOTE = "managed by the platform";

/**
 * Platform-level names (ADR-0031, ADR-0032), the same as naming.bicep (identitiesResourceGroup,
 * identitiesLock, provisioningServiceConnection, instanceServiceConnection).
 */
export const identitiesResourceGroup = (prefix: string, env: string): string => `rg-${prefix}-identities-${env}`;
export const identitiesLock = (prefix: string): string => `lock-${prefix}-identities-readonly`;
export const provisioningServiceConnection = (env: string): string => `sc-platform-provisioning-${env}`;
export function instanceServiceConnection(purpose: "ado" | "entra"): string {
  if (purpose !== "ado" && purpose !== "entra") throw new Error(`instanceServiceConnection: unknown purpose "${String(purpose)}".`);
  return `sc-platform-${purpose}`;
}
/** Folder and name of the provisioning pipeline (pipelines/provisioning.yml in platform-config). */
export const PLATFORM_FOLDER = "\\platform";
export const PROVISIONING_PIPELINE = "provisioning";
/**
 * The platform pipeline of an environment (ADR-0043, naming.bicep adoPlatformPipeline): \platform\platform-{env}
 * from pipelines/platform-{env}.yml, and the environment that carries its Approval
 * (adoPlatformEnvironment). Never an app's: the slug `platform` is reserved.
 */
export const adoPlatformPipeline = (env: string): string => `platform-${env}`;
export const adoPlatformEnvironment = (env: string): string => `platform-${env}`;
/** Entry templates in core that the platform service connections accept (Required template). */
export const PROVISIONING_TEMPLATE = "pipelines/azure-devops/app-provisioning.yml";
export const PLATFORM_TEMPLATE = "pipelines/azure-devops/platform-environment.yml";
/**
 * The PR validation pipeline of platform-config (ADR-0040): \platform\validation from
 * pipelines/validation.yml (VALIDATION_YAML, written by `platform generate`); a build validation
 * policy on platform-config's default branch runs it (`platform ado bootstrap --phase policies`).
 */
export const VALIDATION_PIPELINE = "validation";

/** Branch of the onboarding pull request in a bring-your-own app repository (ADR-0039). */
export const ONBOARDING_BRANCH = "platform/onboarding";
/** Branch folder of the portal's request branches in platform-config (ADR-0040). */
export const PORTAL_REQUESTS_FOLDER = "portal/requests";
