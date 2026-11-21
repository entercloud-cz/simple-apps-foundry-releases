import { CheckFailed, MiB, isObject, own, readJson } from "../pipeline/common.js";

/**
 * `platform environment cae-network` (ADR-0043 amendment 2026-11-15, backlog US03.03 criterion 2): the
 * network of a Container Apps environment (CAE) is fixed once the CAE exists. Microsoft Learn
 * (Networking in Azure Container Apps): "After you create an environment with either the default Azure
 * network or an existing virtual network, you can't change the network type". The platform treats the
 * infrastructure subnet of a VNet-based CAE the same way (Verify in sandbox: PLAT-9). The managed and
 * VNet variants of External only share one CAE name (cae-{prefix}-ext-{env}), so a variant switch can't
 * create the new CAE beside the old one; a hybrid CAE whose VNet or subnet instance.yaml now names
 * differently is the same case.
 *
 * Pure: files in, verdicts out, no Azure calls. The platform pipeline's plan reads every CAE that
 * platform-names.bicep lists (output managedEnvironments: the CAE of each buildable mode, enabled or
 * not) with `az resource show` (null when it doesn't exist) and snapshots environment.bicepparam with
 * the run's inputs offline (`bicep snapshot`). Per CAE, this compares the live
 * properties.vnetConfiguration.infrastructureSubnetId (absent, null or empty = the Azure-managed
 * network) with the one environment.bicep would deploy, case-insensitively:
 *
 *   new          the mode is enabled and the CAE doesn't exist yet: the deployment creates it (never refused)
 *   unchanged    the CAE exists with the network environment.bicep would give it
 *   refused      the CAE exists with another network: the plan stops before validate and what-if
 *   not-enabled  the CAE exists, but instance.yaml no longer enables its mode: reported, never deleted
 *   absent       neither the mode nor the CAE
 *
 * Fails closed: a CAE environment.bicep would deploy that the plan didn't read, a subnet the snapshot
 * left as an expression, or malformed input exits 1 like a refusal.
 */

const MODES = ["externalOnly", "externalHybrid"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = { externalOnly: "External only", externalHybrid: "External with internal access" };

/** cae-{prefix}-{mode}-{env}[-c{cell}] as naming.bicep writes it (at most 32 characters). */
const CAE_NAME_RE = /^cae-[a-z0-9-]{1,28}$/;
/** A subnet's ARM resource ID; only such a value is quoted back in a message. */
const SUBNET_ID_RE = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[-\w.()]{1,90}\/providers\/Microsoft\.Network\/virtualNetworks\/[-\w.]{2,64}\/subnets\/[-\w.]{1,80}$/i;

export const CAE_NETWORK_RUNBOOK = "docs/runbooks/change-external-only-network.md";

export type CaeNetworkState = "new" | "unchanged" | "refused" | "not-enabled" | "absent";

export interface CaeNetworkVerdict {
  mode: Mode;
  name: string;
  state: CaeNetworkState;
  /** The live CAE's infrastructure subnet ID, '' for the Azure-managed network (only when the CAE exists). */
  current?: string;
  /** The subnet ID environment.bicep would deploy, '' for the Azure-managed network (only when the mode is enabled). */
  wanted?: string;
}

export interface CaeNetworkResult {
  caes: CaeNetworkVerdict[];
  /** One plain-language line per refused CAE. */
  refused: string[];
}

/** The infrastructure subnet of a CAE resource (live or predicted); '' for the Azure-managed network. */
function subnetOf(resource: Record<string, unknown>, label: string): string {
  const props = own(resource, "properties");
  if (props !== undefined && props !== null && !isObject(props)) throw new CheckFailed([`${label}: properties is not an object.`]);
  const vnet = isObject(props) ? own(props, "vnetConfiguration") : undefined;
  if (vnet === undefined || vnet === null) return "";
  if (!isObject(vnet)) throw new CheckFailed([`${label}: properties.vnetConfiguration is not an object.`]);
  const subnet = own(vnet, "infrastructureSubnetId");
  if (subnet === undefined || subnet === null || subnet === "") return "";
  if (typeof subnet !== "string") throw new CheckFailed([`${label}: properties.vnetConfiguration.infrastructureSubnetId is not a string.`]);
  return subnet;
}

function describe(subnet: string): string {
  if (subnet === "") return "the Azure-managed network (no VNet)";
  return SUBNET_ID_RE.test(subnet) ? `the subnet ${subnet}` : "a subnet ID of an unexpected shape";
}

function refusal(v: CaeNetworkVerdict): string {
  return (
    `the CAE ${v.name} (${MODE_LABEL[v.mode]}) exists on ${describe(v.current!)}, but instance.yaml now asks for ${describe(v.wanted!)}. ` +
    `A Container Apps environment's network can't change in place, so the plan stops before validate and what-if. ` +
    `Keep the CAE's network in instance.yaml, or follow the core runbook ${CAE_NETWORK_RUNBOOK} (the apps leave the CAE, a person deletes it, then the network changes).`
  );
}

export function caeNetworkCheck(args: { names: unknown; snapshot: unknown; live: unknown }): CaeNetworkResult {
  const outputs = isObject(args.names) ? own(args.names, "outputs") : undefined;
  const listed = isObject(outputs) ? own(outputs, "managedEnvironments") : undefined;
  if (!Array.isArray(listed) || listed.length === 0) {
    throw new CheckFailed(["--names has no outputs.managedEnvironments (the snapshot of infra/platform/pipeline/platform-names.bicepparam)."]);
  }
  const caes: { mode: Mode; name: string }[] = [];
  for (const entry of listed) {
    const mode = isObject(entry) ? own(entry, "mode") : undefined;
    const name = isObject(entry) ? own(entry, "name") : undefined;
    if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode) || typeof name !== "string" || !CAE_NAME_RE.test(name)) {
      throw new CheckFailed(["--names lists a CAE without a known mode or a valid name."]);
    }
    if (caes.some((c) => c.name === name)) throw new CheckFailed([`--names lists the CAE ${name} twice.`]);
    caes.push({ mode: mode as Mode, name });
  }

  // What environment.bicep would deploy: the CAEs among the snapshot's predicted resources.
  const predicted = isObject(args.snapshot) ? own(args.snapshot, "predictedResources") : undefined;
  if (!Array.isArray(predicted)) throw new CheckFailed(["--snapshot has no predictedResources (the bicep snapshot of infra/platform/pipeline/environment.bicepparam)."]);
  const wanted = new Map<string, string>();
  for (const r of predicted) {
    if (!isObject(r) || String(own(r, "type") ?? "").toLowerCase() !== "microsoft.app/managedenvironments") continue;
    const name = own(r, "name");
    if (typeof name !== "string" || !caes.some((c) => c.name === name)) {
      throw new CheckFailed([`environment.bicep would deploy the CAE ${typeof name === "string" && CAE_NAME_RE.test(name) ? name : "(unnamed)"}, which platform-names.bicep doesn't list, so the plan didn't read it (core bug: name it in platform-names.bicep).`]);
    }
    const subnet = subnetOf(r, `--snapshot ${name}`);
    if (subnet !== "" && !subnet.startsWith("/subscriptions/")) {
      throw new CheckFailed([`--snapshot ${name}: the infrastructure subnet is not a resource ID (an unresolved expression?), so the plan can't tell whether the CAE's network changes.`]);
    }
    wanted.set(name, subnet);
  }

  // What exists: one entry per listed CAE, its raw `az resource show` JSON or null.
  if (!Array.isArray(args.live)) throw new CheckFailed(["--live must be a JSON list of {mode, name, resource} (resource: az resource show, or null)."]);
  const live = new Map<string, Record<string, unknown> | null>();
  for (const entry of args.live) {
    const name = isObject(entry) ? own(entry, "name") : undefined;
    const resource = isObject(entry) ? own(entry, "resource") : undefined;
    if (typeof name !== "string" || !caes.some((c) => c.name === name) || live.has(name) || !(resource === null || isObject(resource))) {
      throw new CheckFailed(["--live has an entry that isn't one of the listed CAEs once with a resource object or null."]);
    }
    if (isObject(resource) && String(own(resource, "name") ?? "").toLowerCase() !== name.toLowerCase()) {
      throw new CheckFailed([`--live ${name}: the resource read is named otherwise.`]);
    }
    live.set(name, resource);
  }

  const verdicts: CaeNetworkVerdict[] = [];
  for (const { mode, name } of caes) {
    if (!live.has(name)) throw new CheckFailed([`--live has no entry for the CAE ${name}: the plan reads every CAE platform-names.bicep lists.`]);
    const resource = live.get(name)!;
    const enabled = wanted.has(name);
    if (!resource) {
      verdicts.push({ mode, name, state: enabled ? "new" : "absent", ...(enabled ? { wanted: wanted.get(name)! } : {}) });
      continue;
    }
    const current = subnetOf(resource, `--live ${name}`);
    if (!enabled) {
      verdicts.push({ mode, name, state: "not-enabled", current });
      continue;
    }
    const want = wanted.get(name)!;
    verdicts.push({ mode, name, state: current.toLowerCase() === want.toLowerCase() ? "unchanged" : "refused", current, wanted: want });
  }
  return { caes: verdicts, refused: verdicts.filter((v) => v.state === "refused").map(refusal) };
}

export function caeNetworkFiles(args: { names: string; snapshot: string; live: string }): CaeNetworkResult {
  return caeNetworkCheck({
    names: readJson(args.names, MiB, "--names"),
    snapshot: readJson(args.snapshot, 16 * MiB, "--snapshot"),
    live: readJson(args.live, 4 * MiB, "--live"),
  });
}

export function formatCaeNetwork(r: CaeNetworkResult): string {
  const lines = r.caes.map((v) => {
    switch (v.state) {
      case "new":
        return `  ${v.name} (${MODE_LABEL[v.mode]}): new, on ${describe(v.wanted!)}`;
      case "unchanged":
        return `  ${v.name} (${MODE_LABEL[v.mode]}): exists, network unchanged (${describe(v.current!)})`;
      case "not-enabled":
        return `  ${v.name} (${MODE_LABEL[v.mode]}): exists, but its mode is no longer enabled (not compared, not deleted)`;
      case "refused":
        return `  ${v.name} (${MODE_LABEL[v.mode]}): exists on ${describe(v.current!)}; instance.yaml asks for ${describe(v.wanted!)}`;
      default:
        return `  ${v.name} (${MODE_LABEL[v.mode]}): not enabled, doesn't exist`;
    }
  });
  const verdict = r.refused.length ? `FAIL  ${r.refused.length} existing CAE(s) would change their network` : "OK  no existing CAE changes its network";
  return `CAE networks (existing CAEs keep theirs):\n${lines.join("\n")}\n${verdict}\n`;
}
