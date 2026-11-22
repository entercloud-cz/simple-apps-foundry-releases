/**
 * Basic mode of the portal's new-app wizard (ADR-0047): instance.yaml `newApps.basicMode`.
 *
 * In basic mode the requester gives the app's name, owners, users and look, and the portal fills
 * in the technical choices from this setting: the network mode of the build environments, one
 * database or none, file storage, the company domain, and the starter of the new repository.
 * Advanced mode asks for every choice. The defaults below equal the schema's
 * (config/schema/instance.schema.json, newApps.basicMode; the CLI tests compare them).
 */

export const BASIC_NETWORK_MODES = ["externalOnly", "externalHybrid"] as const;
export const BASIC_DATABASE_ENGINES = ["postgres", "azureSql", "none"] as const;
export const BASIC_DATABASE_SIZES = ["S", "M", "L"] as const;
export const BASIC_STACKS = ["node-ts", "python-fastapi", "dotnet"] as const;

export interface BasicModeSetting {
  enabled: boolean;
  networkMode: (typeof BASIC_NETWORK_MODES)[number];
  databaseEngine: (typeof BASIC_DATABASE_ENGINES)[number];
  databaseSize: (typeof BASIC_DATABASE_SIZES)[number];
  storage: boolean;
  companyDomain: boolean;
  stack: (typeof BASIC_STACKS)[number];
}

export const BASIC_MODE_DEFAULTS: Readonly<BasicModeSetting> = {
  enabled: true,
  networkMode: "externalOnly",
  databaseEngine: "azureSql",
  databaseSize: "S",
  storage: true,
  companyDomain: true,
  stack: "node-ts",
};

interface NewAppsView {
  newApps?: { basicMode?: Partial<BasicModeSetting> };
}

/** newApps.basicMode of the instance with the schema's defaults filled in. */
export function basicModeOf(instance?: NewAppsView): BasicModeSetting {
  const set = instance?.newApps?.basicMode ?? {};
  const out = { ...BASIC_MODE_DEFAULTS };
  for (const key of Object.keys(out) as (keyof BasicModeSetting)[]) {
    const v = set[key];
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}
