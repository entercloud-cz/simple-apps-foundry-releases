/**
 * Ready-to-send texts for the customer's network team (ADR-0027 amendment 2026-11-12, product owner
 * decision: firewalls are always the customer's, so the platform deploys or changes no firewall rule;
 * it writes the request, and people send it through their ITSM tool or straight to the network team).
 * Browser-safe on purpose (package.json exports "./network-request"): `platform network request`
 * prints the environment's text, and the portal writes both texts with the same code.
 *
 * Two texts, in English or Czech:
 *
 *   systemAccessRequest   an app owner's request for a firewall rule from one environment x
 *                         connected network mode to one system of the internal systems catalogue
 *                         (instance.yaml network.internalSystems). The source is the whole
 *                         Container Apps environment's subnet: apps in one CAE share it, so the
 *                         rule serves every one of them (network-modes.md, "Egress allow-list is
 *                         per CAE, not per app").
 *   hubConnectionRequest  a platform admin's request to connect one environment's connected mode to
 *                         the customer's hub: the spoke VNet, the peering both ways, the route table
 *                         to the firewall, the DNS servers and the private DNS zones they must
 *                         resolve, and the standing egress baseline (EGRESS_BASELINE).
 *
 * EGRESS_BASELINE is the one copy of the standing rule set: network-modes.md's table is checked
 * against egressBaselineMarkdownRows() (test/network-request.test.ts).
 *
 * The names (VNet, subnets, peering, DNS resource group) are ports of naming.bicep, compared with
 * infra/tests/naming-vectors.json by the same test. Keep Node imports out.
 */
import { cellCaeSubnetName, cellManagedEnvironmentName, DEFAULT_CELL_ID } from "./capacity.js";

export type RequestLanguage = "en" | "cs";
export const REQUEST_LANGUAGES: readonly RequestLanguage[] = ["en", "cs"];

/** The network modes that can reach internal systems (ADR-0003). internalOnly is not built yet. */
export const CONNECTED_MODES = ["externalHybrid", "internalOnly"] as const;
export type ConnectedMode = (typeof CONNECTED_MODES)[number];
export const isConnectedMode = (mode: string): mode is ConnectedMode => (CONNECTED_MODES as readonly string[]).includes(mode);

/** The firewall rule states of a catalogue entry per environment x mode (instance schema). */
export const RULE_STATES = ["notRequested", "requested", "active", "removed"] as const;
export type RuleState = (typeof RULE_STATES)[number];

/** The longest justification an app owner may give (characters). */
export const JUSTIFICATION_MAX = 1000;

// ------------------------------------------------------------------------------------------
// The standing egress baseline (network-modes.md, ADR-0003)
// ------------------------------------------------------------------------------------------

type Localized = Readonly<Record<RequestLanguage, string>>;

/** A Microsoft Learn page (its title) and the part of it that documents the rule. */
export interface BaselineSource {
  page: string;
  part?: string;
}

/** One line of the standing egress baseline: application rules, HTTPS 443, FQDN matched on TLS SNI. */
export interface EgressBaselineRule {
  id: string;
  purpose: Localized;
  fqdns: readonly string[];
  /** A remark on the FQDNs. */
  note?: Localized;
  sources: readonly BaselineSource[];
}

const FIREWALL_ACA = "Use Azure Firewall with Azure Container Apps";
const FIREWALL_ACR = "Configure rules to access an Azure container registry behind a firewall";

export const EGRESS_BASELINE: readonly EgressBaselineRule[] = [
  {
    id: "aca-images",
    purpose: { en: "Container Apps platform images (Microsoft Artifact Registry)", cs: "Platforma Container Apps: její image (Microsoft Artifact Registry)" },
    fqdns: ["mcr.microsoft.com", "*.data.mcr.microsoft.com"],
    sources: [{ page: FIREWALL_ACA, part: 'application rules, "All scenarios"' }],
  },
  {
    id: "aca-binaries",
    purpose: { en: "Container Apps platform: Kubernetes and CNI binaries", cs: "Platforma Container Apps: binárky Kubernetes a CNI" },
    fqdns: ["packages.aks.azure.com", "acs-mirror.azureedge.net"],
    sources: [{ page: FIREWALL_ACA, part: 'application rules, "All scenarios"' }],
  },
  {
    id: "acr-login",
    purpose: { en: "App registries: login server (REST) of every app's Basic ACR", cs: "Registry aplikací: přihlašovací server (REST) Basic ACR každé aplikace" },
    fqdns: ["*.azurecr.io", "azurecr.io"],
    note: { en: "the bare domain for the wildcard certificate", cs: "holá doména kvůli wildcard certifikátu" },
    sources: [{ page: FIREWALL_ACA, part: '"Azure Container Registry"' }, { page: FIREWALL_ACR }],
  },
  {
    id: "acr-data",
    purpose: { en: "App registries: layer downloads (data endpoint)", cs: "Registry aplikací: stahování vrstev (datový endpoint)" },
    fqdns: ["*.blob.core.windows.net"],
    sources: [{ page: FIREWALL_ACR, part: "Basic registries have no dedicated data endpoints (Premium only), so layers are served from Azure Storage" }, { page: FIREWALL_ACA, part: '"Azure Container Registry"' }],
  },
  {
    id: "entra",
    purpose: { en: "Entra ID, managed identity, Easy Auth sign-in", cs: "Entra ID, spravovaná identita, přihlášení přes Easy Auth" },
    fqdns: ["login.microsoft.com", "login.microsoftonline.com", "*.login.microsoftonline.com", "*.login.microsoft.com", "*.identity.azure.net"],
    sources: [{ page: FIREWALL_ACA, part: '"Managed identity" and "Azure Container Registry"' }],
  },
  {
    id: "app-insights",
    purpose: { en: "Application Insights ingestion and Live Metrics", cs: "Application Insights: příjem telemetrie a Live Metrics" },
    fqdns: ["*.in.applicationinsights.azure.com", "*.livediagnostics.monitor.azure.com"],
    note: { en: "regional endpoints; the global ones are deprecated", cs: "regionální endpointy; globální jsou zastaralé" },
    sources: [{ page: "Azure Monitor endpoint access and firewall configuration" }],
  },
];

/** The wildcards whose residual risk the product owner accepted on 2026-10-26 (ADR-0003). */
export const BASELINE_RISK_FQDNS: readonly string[] = ["*.azurecr.io", "*.blob.core.windows.net"];

/** The rows of network-modes.md's baseline table (Purpose | FQDNs | Source), one Markdown line each. */
export function egressBaselineMarkdownRows(): string[] {
  return EGRESS_BASELINE.map((r) => {
    const fqdns = r.fqdns.map((f) => `\`${f}\``).join(", ") + (r.note ? ` (${r.note.en})` : "");
    const sources = r.sources.map((s) => `*${s.page}*${s.part ? `, ${s.part}` : ""}`).join("; ");
    return `| ${r.purpose.en} | ${fqdns} | ${sources} |`;
  });
}

/**
 * The private DNS zones environment.bicep creates per VNet-based spoke (services vault, postgres,
 * sql, blob; naming.bicep privateDnsZone), with the public cloud's suffixes.
 */
export const PRIVATE_DNS_ZONES: readonly string[] = ["privatelink.vaultcore.azure.net", "privatelink.postgres.database.azure.com", "privatelink.database.windows.net", "privatelink.blob.core.windows.net"];

// ------------------------------------------------------------------------------------------
// Names (ports of naming.bicep; test/network-request.test.ts checks them against the vectors)
// ------------------------------------------------------------------------------------------

const MODE_ABBREVIATION: Readonly<Record<ConnectedMode, string>> = { externalHybrid: "hyb", internalOnly: "int" };
const TOKEN_RE = /^[a-z][a-z0-9]*$/;
function tok(value: string, what: string): string {
  if (value.length < 2 || value.length > 8 || !TOKEN_RE.test(value)) throw new NetworkRequestError("input", `naming: invalid ${what} "${value.slice(0, 20)}" (2-8 characters, ^[a-z][a-z0-9]{1,7}$, ADR-0020).`);
  return value;
}

/** vnet-{prefix}-{mode}-{env} (naming.bicep virtualNetwork) */
export const spokeVnetName = (prefix: string, mode: ConnectedMode, env: string): string => `vnet-${tok(prefix, "instance prefix")}-${MODE_ABBREVIATION[mode]}-${tok(env, "environment name")}`;
/** snet-{prefix}-pep-{mode}-{env} (naming.bicep subnet, purpose pep) */
export const privateEndpointSubnetName = (prefix: string, mode: ConnectedMode, env: string): string => `snet-${tok(prefix, "instance prefix")}-pep-${MODE_ABBREVIATION[mode]}-${tok(env, "environment name")}`;
/** peer-{prefix}-{mode}-{env}-to-hub (naming.bicep hubPeering) */
export const hubPeeringName = (prefix: string, mode: ConnectedMode, env: string): string => `peer-${tok(prefix, "instance prefix")}-${MODE_ABBREVIATION[mode]}-${tok(env, "environment name")}-to-hub`;
/** rg-{prefix}-dns-{mode}-{env} (naming.bicep privateDnsResourceGroup) */
export const privateDnsResourceGroupName = (prefix: string, mode: ConnectedMode, env: string): string => `rg-${tok(prefix, "instance prefix")}-dns-${MODE_ABBREVIATION[mode]}-${tok(env, "environment name")}`;
/** rg-{prefix}-platform-{env} (naming.bicep platformResourceGroup) */
export const platformResourceGroupName = (prefix: string, env: string): string => `rg-${tok(prefix, "instance prefix")}-platform-${tok(env, "environment name")}`;

// ------------------------------------------------------------------------------------------
// The configuration the texts read (structural: the CLI's parsed instance.yaml and the portal's
// validated configuration both fit)
// ------------------------------------------------------------------------------------------

export interface RequestEndpoint {
  host?: string;
  ip?: string;
  cidr?: string;
  ports: readonly (number | string)[];
  protocol: string;
}

export interface RequestSystem {
  id: string;
  name: string;
  description?: string;
  location: string;
  endpoints: readonly RequestEndpoint[];
  connectivity: string;
  allowedEnvironments: readonly string[];
  allowedNetworkModes: readonly string[];
  requiresApproval: boolean;
  owner: { name: string; email?: string; team?: string };
  firewallRules?: readonly { environment: string; networkMode: string; status: string; reference?: string }[];
}

export interface RequestConnectedMode {
  vnet: { existingVnetId?: string; create?: { addressSpace: string; useRemoteGateways?: boolean } };
  caeSubnetPrefix: string;
  privateEndpointSubnetPrefix: string;
  routeTableId: string;
  dnsServers?: readonly string[];
  egressAllowListProcess?: string;
  egressBaseline?: { status: string; reference?: string };
}

export interface RequestEnvironment {
  name: string;
  kind: string;
  subscriptionId: string;
  region?: string;
  hub?: { vnetId: string; firewallPrivateIp: string };
  networkModes?: { externalHybrid?: RequestConnectedMode; internalOnly?: RequestConnectedMode; [mode: string]: unknown };
}

export interface RequestInstance {
  productName?: string;
  defaultRegion: string;
  naming: { prefix: string };
  environments: readonly RequestEnvironment[];
  network?: { internalSystems?: readonly RequestSystem[] };
}

export interface RequestPerson {
  name?: string;
  email?: string;
}

export interface RequestApp {
  slug: string;
  title: string;
  owner: RequestPerson;
  deputy: RequestPerson;
  /** The app's network mode per environment (app.yaml environments.<env>.networkMode). */
  environments: Readonly<Record<string, { networkMode: string }>>;
}

/** Why a text can't be written; `code` is stable (the portal maps it to its answers). */
export type NetworkRequestProblem = "input" | "environment" | "mode" | "notConfigured" | "noHub" | "system" | "notOffered" | "active";

export class NetworkRequestError extends Error {
  constructor(
    readonly code: NetworkRequestProblem,
    message: string,
  ) {
    super(message);
    this.name = "NetworkRequestError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The environment's configuration of a connected mode, if it has one. */
export function connectedModeOf(env: RequestEnvironment, mode: ConnectedMode): RequestConnectedMode | undefined {
  const c = env.networkModes?.[mode];
  return isObj(c) ? (c as unknown as RequestConnectedMode) : undefined;
}

/** A catalogue entry's firewall rule for one environment x mode; no entry = not requested. */
export function firewallRuleOf(system: RequestSystem, environment: string, mode: string): { status: RuleState; reference?: string } {
  const r = (system.firewallRules ?? []).find((x) => x.environment === environment && x.networkMode === mode);
  if (!r) return { status: "notRequested" };
  const status = (RULE_STATES as readonly string[]).includes(r.status) ? (r.status as RuleState) : "notRequested";
  return { status, ...(r.reference ? { reference: r.reference } : {}) };
}

/** Whether apps in this environment x mode may ask for the system (its allowed environments and modes). */
export const systemOffered = (system: RequestSystem, environment: string, mode: string): boolean => system.allowedEnvironments.includes(environment) && system.allowedNetworkModes.includes(mode);

/** The catalogue entries apps in an environment x mode may ask for, in catalogue order. */
export function systemsOffered(instance: RequestInstance, environment: string, mode: string): RequestSystem[] {
  return (instance.network?.internalSystems ?? []).filter((s) => systemOffered(s, environment, mode));
}

// ------------------------------------------------------------------------------------------
// Wording
// ------------------------------------------------------------------------------------------

const MODE_LABEL: Record<RequestLanguage, Record<ConnectedMode, string>> = {
  en: { externalHybrid: "Internet + internal systems (externalHybrid)", internalOnly: "Internal only (internalOnly)" },
  cs: { externalHybrid: "Z internetu + interní systémy (externalHybrid)", internalOnly: "Jen interně (internalOnly)" },
};
const MODE_SHORT: Record<RequestLanguage, Record<ConnectedMode, string>> = {
  en: { externalHybrid: "Internet + internal systems", internalOnly: "Internal only" },
  cs: { externalHybrid: "Z internetu + interní systémy", internalOnly: "Jen interně" },
};
const KIND_LABEL: Record<RequestLanguage, Record<string, string>> = {
  en: { prod: "production", nonprod: "non-production" },
  cs: { prod: "produkční", nonprod: "neprodukční" },
};
const LOCATION_LABEL: Record<RequestLanguage, Record<string, string>> = {
  en: { onPrem: "on-premises", azure: "Azure" },
  cs: { onPrem: "on-premise (firemní datové centrum)", azure: "Azure" },
};
const CONNECTIVITY_LABEL: Record<RequestLanguage, Record<string, string>> = {
  en: { expressRoute: "ExpressRoute", vpn: "site-to-site VPN", hubPeering: "Azure, peering with the hub", other: "other (ask the system owner)" },
  cs: { expressRoute: "ExpressRoute", vpn: "site-to-site VPN", hubPeering: "Azure, peering s hubem", other: "jinak (zeptej se vlastníka systému)" },
};
const RULE_LABEL: Record<RequestLanguage, Record<RuleState, string>> = {
  en: { notRequested: "not requested yet", requested: "already requested", active: "open", removed: "removed" },
  cs: { notRequested: "zatím nikdo nežádal", requested: "už je zažádané", active: "otevřené", removed: "zrušené" },
};
const BASELINE_LABEL: Record<RequestLanguage, Record<string, string>> = {
  en: { notRequested: "not requested yet", requested: "requested", active: "active" },
  cs: { notRequested: "zatím nikdo nežádal", requested: "zažádané", active: "aktivní" },
};

/** YYYY-MM-DD (en) or D. M. YYYY (cs), UTC. */
function day(date: Date, lang: RequestLanguage): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return lang === "cs" ? `${d}. ${m}. ${y}` : `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Label-value lines with the values aligned; an empty label continues the line above. */
function rows(width: number, pairs: readonly (readonly [string, string])[]): string[] {
  return pairs.map(([k, v]) => `  ${(k ? `${k}:` : "").padEnd(width)}${v}`);
}

/** The value column of a text: after its longest label. */
const columnOf = (labels: readonly string[]): number => Math.max(...labels.map((l) => l.length)) + 2;

const person = (p: RequestPerson): string => (p.name && p.email ? `${p.name} <${p.email}>` : (p.name ?? p.email ?? "-"));
const lastSegment = (id: string): string => id.split("/").filter(Boolean).pop() ?? id;
/** One line of free text: control characters out, runs of white space as one space. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
/** Free text over several lines: control characters except line breaks out, each line indented. */
const paragraph = (s: string): string[] =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .map((l) => (l === "" ? "" : `  ${l}`));

function endpointText(e: RequestEndpoint): string {
  const target = e.host ?? e.ip ?? e.cidr ?? "?";
  return `${target}  ${e.protocol.toUpperCase()} ${e.ports.join(", ")}`;
}

const productOf = (instance: RequestInstance): string => instance.productName ?? "SAF";

/** The environment by name, and its connected mode, or the problem. */
function environmentAndMode(instance: RequestInstance, environment: string, mode: ConnectedMode): { env: RequestEnvironment; config: RequestConnectedMode; hub: { vnetId: string; firewallPrivateIp: string } } {
  const env = instance.environments.find((e) => e.name === environment);
  if (!env) throw new NetworkRequestError("environment", `"${environment.slice(0, 40)}" is not an environment of this instance (${instance.environments.map((e) => e.name).join(", ")}).`);
  const config = connectedModeOf(env, mode);
  if (!config) throw new NetworkRequestError("notConfigured", `environment ${env.name} has no ${mode} network mode in instance.yaml.`);
  if (!env.hub) throw new NetworkRequestError("noHub", `environment ${env.name} has no hub in instance.yaml (required for ${mode}).`);
  return { env, config, hub: env.hub };
}

// ------------------------------------------------------------------------------------------
// The app owner's request for an internal system
// ------------------------------------------------------------------------------------------

export interface SystemAccessInput {
  instance: RequestInstance;
  app: RequestApp;
  environment: string;
  system: string;
  justification: string;
  /** Who wrote the text (the signed-in owner or deputy). */
  requestedBy?: string;
  date: Date;
  lang: RequestLanguage;
}

/** What a system request would be about, or the problem (checked before a text is written). */
export function checkSystemAccess(input: Pick<SystemAccessInput, "instance" | "app" | "environment" | "system">): { env: RequestEnvironment; mode: ConnectedMode; config: RequestConnectedMode; hub: { vnetId: string; firewallPrivateIp: string }; system: RequestSystem; rule: { status: RuleState; reference?: string } } {
  const appEnv = Object.hasOwn(input.app.environments, input.environment) ? input.app.environments[input.environment] : undefined;
  if (!appEnv) throw new NetworkRequestError("environment", `the app ${input.app.slug} doesn't run in ${input.environment.slice(0, 40)}.`);
  const mode = appEnv.networkMode;
  if (!isConnectedMode(mode)) throw new NetworkRequestError("mode", `the app runs in ${input.environment} in the ${mode} network mode, which can't reach internal systems (only ${CONNECTED_MODES.join(" and ")} can).`);
  const { env, config, hub } = environmentAndMode(input.instance, input.environment, mode);
  const system = (input.instance.network?.internalSystems ?? []).find((s) => s.id === input.system);
  if (!system) throw new NetworkRequestError("system", `"${input.system.slice(0, 40)}" is not a system of the internal systems catalogue.`);
  if (!systemOffered(system, env.name, mode)) throw new NetworkRequestError("notOffered", `the catalogue doesn't offer ${system.id} to ${env.name} in the ${mode} network mode.`);
  const rule = firewallRuleOf(system, env.name, mode);
  if (rule.status === "active") throw new NetworkRequestError("active", `the rule from ${env.name} (${mode}) to ${system.id} is already open: nothing to send.`);
  return { env, mode, config, hub, system, rule };
}

const SYSTEM_TEXT = {
  en: {
    title: (app: string, env: string, system: string) => `Firewall rule request: ${app} (${env}) to ${system}`,
    ask: "Please open a firewall rule so that the app below can reach an internal system.",
    process: (p: string) => `How to send it: ${p}`,
    noProcess: "How to send it: your organisation hasn't named a process yet; ask the platform team where firewall requests go.",
    app: "APP",
    appName: "App",
    owner: "Owner",
    deputy: "Deputy",
    by: "Asked by",
    environment: "Environment",
    mode: "Network mode",
    source: "SOURCE",
    subnet: "Subnet",
    subnetValue: (prefix: string, cae: string) => `${prefix} (subnet of the Container Apps environment ${cae})`,
    hop: "Next hop",
    hopValue: (ip: string, rt: string) => `the hub firewall ${ip} (route table ${rt})`,
    whole: "Whole environment",
    wholeValue: (env: string, mode: string) => `The rule applies to the whole Container Apps environment, not to this app alone. Every app in ${env} in the ${mode} network mode shares this subnet, and the firewall can't tell the apps apart, so all of them will be able to reach the system.`,
    destination: "DESTINATION",
    system: "System",
    systemValue: (name: string, id: string) => `${name} (catalogue ID ${id})`,
    description: "Description",
    endpoints: "Endpoints",
    location: "Location",
    connectivity: "Connectivity",
    connectivityValue: (c: string) => `${c} (from the hub firewall)`,
    systemOwner: "System owner",
    approval: "Approval",
    approvalYes: "The system owner must approve this access before the rule is opened.",
    approvalNo: "The catalogue says apps need no approval of the system owner for this system.",
    names: "Host names",
    namesCustom: (dns: string) => `must resolve through the spoke's DNS servers (${dns}).`,
    namesAzure: "the spoke uses Azure-provided DNS, which resolves public names and private DNS zones linked to the spoke only.",
    why: "WHY THE APP NEEDS IT",
    state: "STATE",
    stateLine: (env: string, mode: string, s: string) => `Rule from ${env} (${mode}): ${s}`,
    stateRef: (r: string) => `reference ${r}`,
    stateRequested: "The rule was asked for already: this request adds this app's reason. Once the rule is open, the app reaches the system too.",
    stateRemoved: "This request asks for the rule again.",
    after: "AFTER THE CHANGE",
    afterText: "Please send the change or ticket number to the platform team. A platform admin records the rule as open in the portal; from then on the apps' owners see that the system can be reached.",
    footer: (product: string, date: string) => `Written by ${product} on ${date}. The platform itself changes no firewall rule.`,
  },
  cs: {
    title: (app: string, env: string, system: string) => `Žádost o pravidlo firewallu: ${app} (${env}) → ${system}`,
    ask: "Prosím o otevření pravidla na firewallu, aby se aplikace níže dostala k internímu systému.",
    process: (p: string) => `Kam žádost poslat: ${p}`,
    noProcess: "Kam žádost poslat: firma zatím žádný postup neurčila; zeptej se platform týmu, kam žádosti o firewall patří.",
    app: "APLIKACE",
    appName: "Aplikace",
    owner: "Vlastník",
    deputy: "Zástupce",
    by: "Žádá",
    environment: "Prostředí",
    mode: "Režim sítě",
    source: "ZDROJ",
    subnet: "Podsíť",
    subnetValue: (prefix: string, cae: string) => `${prefix} (podsíť prostředí Container Apps ${cae})`,
    hop: "Další skok",
    hopValue: (ip: string, rt: string) => `firewall v hubu ${ip} (směrovací tabulka ${rt})`,
    whole: "Celé prostředí",
    wholeValue: (env: string, mode: string) => `Pravidlo platí pro celé prostředí Container Apps, ne jen pro tuhle aplikaci. Všechny aplikace v prostředí ${env} v režimu sítě ${mode} sdílejí tuhle podsíť a firewall je od sebe nerozliší, takže se k systému dostane každá z nich.`,
    destination: "CÍL",
    system: "Systém",
    systemValue: (name: string, id: string) => `${name} (ID v katalogu ${id})`,
    description: "Popis",
    endpoints: "Adresy",
    location: "Kde běží",
    connectivity: "Spojení",
    connectivityValue: (c: string) => `${c} (z firewallu v hubu)`,
    systemOwner: "Vlastník systému",
    approval: "Souhlas",
    approvalYes: "Vlastník systému musí s přístupem souhlasit, než se pravidlo otevře.",
    approvalNo: "Podle katalogu aplikace k tomuhle systému souhlas vlastníka nepotřebují.",
    names: "Názvy serverů",
    namesCustom: (dns: string) => `musí jít přeložit přes DNS servery spoke sítě (${dns}).`,
    namesAzure: "spoke síť používá DNS od Azure, které přeloží jen veřejné názvy a privátní DNS zóny propojené se spoke sítí.",
    why: "PROČ TO APLIKACE POTŘEBUJE",
    state: "STAV",
    stateLine: (env: string, mode: string, s: string) => `Pravidlo z prostředí ${env} (${mode}): ${s}`,
    stateRef: (r: string) => `číslo ${r}`,
    stateRequested: "O pravidlo už někdo požádal: tahle žádost přidává důvod téhle aplikace. Jakmile se pravidlo otevře, dostane se k systému i ona.",
    stateRemoved: "Tahle žádost žádá o pravidlo znovu.",
    after: "PO ZMĚNĚ",
    afterText: "Pošli prosím číslo změny nebo tiketu platform týmu. Správce platformy zapíše v portálu, že je pravidlo otevřené; od té chvíle vlastníci aplikací uvidí, že se k systému dostanou.",
    footer: (product: string, date: string) => `Napsal ${product} ${date}. Platforma sama žádné pravidlo firewallu nemění.`,
  },
} as const;

/** The app owner's request text for one internal system, or a NetworkRequestError. */
export function systemAccessRequest(input: SystemAccessInput): { text: string; fileName: string; rule: { status: RuleState; reference?: string } } {
  const { env, mode, config, hub, system, rule } = checkSystemAccess(input);
  const justification = input.justification.trim();
  if (justification === "") throw new NetworkRequestError("input", "a justification is required.");
  if (justification.length > JUSTIFICATION_MAX) throw new NetworkRequestError("input", `the justification is longer than ${JUSTIFICATION_MAX} characters.`);
  const L = SYSTEM_TEXT[input.lang];
  const W = columnOf([L.appName, L.owner, L.deputy, L.by, L.environment, L.mode, L.subnet, L.hop, L.whole, L.system, L.description, L.endpoints, L.location, L.connectivity, L.systemOwner, L.approval, L.names]);
  const prefix = input.instance.naming.prefix;
  const cae = cellManagedEnvironmentName(prefix, mode, env.name, DEFAULT_CELL_ID);
  const modeLabel = MODE_LABEL[input.lang][mode];
  const dns = config.dnsServers ?? [];
  const process = config.egressAllowListProcess?.trim();
  const app = input.app;
  const lines: string[] = [
    L.title(oneLine(app.title), env.name, oneLine(system.name)),
    "",
    L.ask,
    process ? L.process(oneLine(process)) : L.noProcess,
    "",
    L.app,
    ...rows(W, [
      [L.appName, `${oneLine(app.title)} (${app.slug})`],
      [L.owner, oneLine(person(app.owner))],
      [L.deputy, oneLine(person(app.deputy))],
      ...(input.requestedBy ? ([[L.by, oneLine(input.requestedBy)]] as const) : []),
      [L.environment, `${env.name} (${KIND_LABEL[input.lang][env.kind] ?? env.kind})`],
      [L.mode, modeLabel],
    ]),
    "",
    L.source,
    ...rows(W, [
      [L.subnet, L.subnetValue(config.caeSubnetPrefix, cae)],
      [L.hop, L.hopValue(hub.firewallPrivateIp, lastSegment(config.routeTableId))],
      [L.whole, L.wholeValue(env.name, modeLabel)],
    ]),
    "",
    L.destination,
    ...rows(W, [
      [L.system, L.systemValue(oneLine(system.name), system.id)],
      ...(system.description ? ([[L.description, oneLine(system.description)]] as const) : []),
      ...system.endpoints.map((e, i) => [i === 0 ? L.endpoints : "", endpointText(e)] as const),
      [L.location, LOCATION_LABEL[input.lang][system.location] ?? system.location],
      [L.connectivity, L.connectivityValue(CONNECTIVITY_LABEL[input.lang][system.connectivity] ?? system.connectivity)],
      [L.systemOwner, oneLine(person({ name: system.owner.team ? `${system.owner.name} (${system.owner.team})` : system.owner.name, ...(system.owner.email ? { email: system.owner.email } : {}) }))],
      [L.approval, system.requiresApproval ? L.approvalYes : L.approvalNo],
      ...(system.endpoints.some((e) => e.host) ? ([[L.names, dns.length > 0 ? L.namesCustom(dns.join(", ")) : L.namesAzure]] as const) : []),
    ]),
    "",
    L.why,
    ...paragraph(justification),
    "",
    L.state,
    `  ${L.stateLine(env.name, modeLabel, RULE_LABEL[input.lang][rule.status] + (rule.reference ? ` (${L.stateRef(oneLine(rule.reference))})` : ""))}`,
    ...(rule.status === "requested" ? [`  ${L.stateRequested}`] : rule.status === "removed" ? [`  ${L.stateRemoved}`] : []),
    "",
    L.after,
    `  ${L.afterText}`,
    "",
    L.footer(productOf(input.instance), day(input.date, input.lang)),
    "",
  ];
  return { text: lines.join("\n"), fileName: `firewall-request-${app.slug}-${env.name}-${system.id}.txt`, rule };
}

// ------------------------------------------------------------------------------------------
// The platform admin's request to connect an environment's connected mode to the hub
// ------------------------------------------------------------------------------------------

export interface HubConnectionInput {
  instance: RequestInstance;
  environment: string;
  mode?: ConnectedMode;
  requestedBy?: string;
  date: Date;
  lang: RequestLanguage;
}

const HUB_TEXT = {
  en: {
    title: (env: string, mode: string) => `Network request: connect ${env} (${mode}) to the hub`,
    ask: "Please connect the network below to the hub and open the standing firewall rule set it needs. It is a one-time change for this environment: new apps need no firewall change of their own; only internal systems are asked for one by one.",
    process: (p: string) => `How to send it: ${p}`,
    noProcess: "How to send it: no process is recorded in instance.yaml (egressAllowListProcess).",
    environment: "ENVIRONMENT",
    platform: "Platform",
    platformValue: (product: string, prefix: string) => `${product} (instance prefix ${prefix})`,
    env: "Environment",
    subscription: "Subscription",
    region: "Region",
    mode: "Network mode",
    cae: "Container Apps environment",
    caeValue: (cae: string, rg: string) => `${cae} (resource group ${rg})`,
    vnet: "1. SPOKE VNET",
    vnetExisting: (id: string) => `VNet: ${id} (yours: the platform doesn't change the VNet itself; it must be in the environment's subscription and region).`,
    vnetExistingSubnets: "The platform creates these two subnets in it and re-applies their settings on every deployment:",
    vnetCreate: (name: string, rg: string, space: string) => `VNet: ${name} in ${rg}, created by the platform, address space ${space}, with these two subnets:`,
    caeSubnet: "Container Apps environment, delegated to Microsoft.App/environments, route table below",
    pepSubnet: "private endpoints of the apps' Key Vaults, databases and storage",
    peering: "2. PEERING WITH THE HUB (BOTH WAYS)",
    hubVnet: "Hub VNet",
    spokeToHub: "Spoke to hub",
    spokeToHubValue: (name: string, remote: boolean) => `${name}, created by the platform: virtual network access allowed, forwarded traffic allowed, gateway transit off, use remote gateways ${remote ? "on" : "off"}.`,
    hubToSpoke: "Hub to spoke",
    hubToSpokeValue: (remote: boolean) => `created by the network team (the hub is yours) once the platform has created the spoke VNet: virtual network access allowed, forwarded traffic allowed${remote ? ", gateway transit allowed (the spoke uses the hub's gateways)" : ""}.`,
    existingPeering: "Both directions are yours, as the VNet is: the platform creates no peering for an existing VNet.",
    remoteGateways: "Use remote gateways",
    remoteGatewaysValue: (on: boolean) => (on ? "yes (instance.yaml useRemoteGateways): the hub's VPN or ExpressRoute gateway serves the spoke." : "no (instance.yaml useRemoteGateways)."),
    remoteGatewaysExisting: "your choice: the peering is yours.",
    route: "3. ROUTE TABLE",
    routeTable: "Route table",
    routeTableValue: (id: string) => `${id} (yours)`,
    defaultRoute: "Default route",
    defaultRouteValue: (ip: string) => `0.0.0.0/0 to the firewall ${ip} (next hop: virtual appliance)`,
    routeNote: (subnet: string) => `The platform associates the route table with ${subnet} and re-applies it on every deployment; it doesn't change the routes.`,
    routeOpen: "Open point: replies to inbound internet traffic of the environment's public ingress must not return asymmetrically through the firewall with this default route (not verified yet).",
    dns: "4. DNS",
    dnsServers: "DNS servers",
    dnsServersCustom: (s: string) => `${s} (set on the spoke VNet)`,
    dnsServersAzure: "Azure-provided DNS (no custom DNS servers in instance.yaml)",
    dnsMust: "They must resolve:",
    dnsPublic: "public names: the FQDNs in step 5 and what apps call on the internet;",
    dnsSystems: "the host names of the internal systems apps will reach;",
    dnsPrivate: (rg: string) => `the private endpoints in the private-endpoint subnet, through these private DNS zones, which the platform creates in ${rg} and links to the spoke VNet:`,
    dnsOpen: "Open point: with your own DNS servers, these zones answer only if your DNS forwards them to Azure DNS from a VNet linked to the zones. Where the privatelink zones live when a spoke uses custom DNS servers is not decided yet (ADR-0028, deferred on 2026-11-01): your DNS forwarding to the platform's zones, central privatelink zones of yours, or Azure-provided DNS in this spoke. Please tell the platform team which one fits your network.",
    dnsAzure: "With Azure-provided DNS the zones linked to the spoke resolve the private endpoints. Host names of internal systems resolve only if they are in a private DNS zone linked to the spoke; otherwise apps use IP addresses.",
    baseline: "5. STANDING EGRESS BASELINE (ONE-TIME FIREWALL RULE SET)",
    source: "Source",
    sourceValue: (prefix: string) => `${prefix} (the whole subnet of the Container Apps environment)`,
    ruleType: "Rule type",
    ruleTypeValue: "application rules, HTTPS on port 443, FQDN matched on TLS SNI",
    sources: "Sources (Microsoft Learn)",
    risk: (fqdns: string) => `Accepted risk: ${fqdns} also match other tenants' registries and storage accounts, a data exfiltration route Microsoft names. The product owner accepted it on 2026-10-26; please confirm in writing that your team accepts it too, with the change reference.`,
    notIn: "Not in this rule set: the apps' Key Vaults, databases and storage (private endpoints in the spoke), Docker Hub, and internal systems (below).",
    state: "State",
    stateValue: (s: string, ref?: string) => (ref ? `${s} (reference ${ref})` : s),
    systems: "6. INTERNAL SYSTEMS",
    systemsText: "Rules to internal systems are separate requests: an app's owner asks for each system from the portal, and the rule then serves the whole Container Apps environment.",
    systemsList: "In the catalogue for this environment:",
    systemsNone: "The catalogue has no system for this environment yet.",
    systemLine: (name: string, id: string, state: string) => `${name} (${id}): rule ${state}`,
    after: "AFTER THE CHANGE",
    afterText: "Please send the change references to the platform team. A platform admin records the standing rule set as active in the portal (egressBaseline); provisioning accepts apps in this network mode only after that. The platform deploys its side (subnets, and for a VNet it creates the VNet and the spoke-to-hub peering) in the environment's platform pipeline run, after its approval.",
    footer: (product: string, date: string, by?: string) => `Written by ${product} on ${date}${by ? ` for ${by}` : ""}. The platform itself changes no firewall rule.`,
  },
  cs: {
    title: (env: string, mode: string) => `Žádost o síť: připojit ${env} (${mode}) k hubu`,
    ask: "Prosím o připojení sítě níže k hubu a o otevření stálé sady pravidel firewallu, kterou potřebuje. Pro tohle prostředí je to jednorázová změna: nové aplikace žádnou vlastní změnu firewallu nepotřebují, jen o interní systémy se žádá po jednom.",
    process: (p: string) => `Kam žádost poslat: ${p}`,
    noProcess: "Kam žádost poslat: instance.yaml žádný postup neuvádí (egressAllowListProcess).",
    environment: "PROSTŘEDÍ",
    platform: "Platforma",
    platformValue: (product: string, prefix: string) => `${product} (prefix instance ${prefix})`,
    env: "Prostředí",
    subscription: "Předplatné",
    region: "Region",
    mode: "Režim sítě",
    cae: "Prostředí Container Apps",
    caeValue: (cae: string, rg: string) => `${cae} (skupina prostředků ${rg})`,
    vnet: "1. SPOKE VNET",
    vnetExisting: (id: string) => `VNet: ${id} (váš: platforma samotnou VNet nemění; musí být v předplatném a regionu prostředí).`,
    vnetExistingSubnets: "Platforma v ní vytvoří tyhle dvě podsítě a při každém nasazení jim nastavení obnoví:",
    vnetCreate: (name: string, rg: string, space: string) => `VNet: ${name} v ${rg}, vytvoří ji platforma, rozsah adres ${space}, s těmito dvěma podsítěmi:`,
    caeSubnet: "prostředí Container Apps, delegovaná na Microsoft.App/environments, směrovací tabulka níže",
    pepSubnet: "privátní endpointy trezorů klíčů, databází a úložišť aplikací",
    peering: "2. PEERING S HUBEM (OBĚMA SMĚRY)",
    hubVnet: "VNet hubu",
    spokeToHub: "Spoke → hub",
    spokeToHubValue: (name: string, remote: boolean) => `${name}, vytvoří platforma: přístup k virtuální síti povolen, přeposlaný provoz povolen, gateway transit vypnutý, use remote gateways ${remote ? "zapnuté" : "vypnuté"}.`,
    hubToSpoke: "Hub → spoke",
    hubToSpokeValue: (remote: boolean) => `vytvoří síťový tým (hub je váš), až platforma vytvoří spoke VNet: přístup k virtuální síti povolen, přeposlaný provoz povolen${remote ? ", gateway transit povolen (spoke používá brány hubu)" : ""}.`,
    existingPeering: "Oba směry jsou vaše, stejně jako VNet: pro existující VNet platforma žádný peering nevytváří.",
    remoteGateways: "Use remote gateways",
    remoteGatewaysValue: (on: boolean) => (on ? "ano (useRemoteGateways v instance.yaml): spoke používá VPN nebo ExpressRoute bránu hubu." : "ne (useRemoteGateways v instance.yaml)."),
    remoteGatewaysExisting: "podle vás: peering je váš.",
    route: "3. SMĚROVACÍ TABULKA",
    routeTable: "Směrovací tabulka",
    routeTableValue: (id: string) => `${id} (vaše)`,
    defaultRoute: "Výchozí trasa",
    defaultRouteValue: (ip: string) => `0.0.0.0/0 na firewall ${ip} (další skok: virtual appliance)`,
    routeNote: (subnet: string) => `Platforma směrovací tabulku přiřadí k ${subnet} a při každém nasazení ji přiřadí znovu; trasy v ní nemění.`,
    routeOpen: "Otevřený bod: odpovědi na příchozí provoz z internetu na veřejný vstup prostředí se s touhle výchozí trasou nesmí vracet nesouměrně přes firewall (zatím neověřeno).",
    dns: "4. DNS",
    dnsServers: "DNS servery",
    dnsServersCustom: (s: string) => `${s} (nastavené na spoke VNet)`,
    dnsServersAzure: "DNS od Azure (instance.yaml neuvádí vlastní DNS servery)",
    dnsMust: "Musí přeložit:",
    dnsPublic: "veřejné názvy: FQDN z bodu 5 a to, co aplikace volají v internetu;",
    dnsSystems: "názvy serverů interních systémů, ke kterým se aplikace dostanou;",
    dnsPrivate: (rg: string) => `privátní endpointy v podsíti pro privátní endpointy, přes tyhle privátní DNS zóny, které platforma vytvoří v ${rg} a propojí se spoke VNet:`,
    dnsOpen: "Otevřený bod: s vlastními DNS servery tyhle zóny odpoví, jen když je vaše DNS přepošle do Azure DNS z VNet propojené se zónami. Kde privatelink zóny budou, když spoke používá vlastní DNS servery, zatím není rozhodnuté (ADR-0028, odloženo 1. 11. 2026): přeposílání z vaší DNS na zóny platformy, vaše centrální privatelink zóny, nebo DNS od Azure v téhle spoke síti. Dejte prosím platform týmu vědět, co se do vaší sítě hodí.",
    dnsAzure: "S DNS od Azure zóny propojené se spoke sítí přeloží privátní endpointy. Názvy serverů interních systémů se přeloží, jen když jsou v privátní DNS zóně propojené se spoke sítí; jinak aplikace použijí IP adresy.",
    baseline: "5. STÁLÁ SADA ODCHOZÍCH PRAVIDEL (JEDNORÁZOVĚ)",
    source: "Zdroj",
    sourceValue: (prefix: string) => `${prefix} (celá podsíť prostředí Container Apps)`,
    ruleType: "Typ pravidel",
    ruleTypeValue: "aplikační pravidla, HTTPS na portu 443, FQDN podle TLS SNI",
    sources: "Zdroje (Microsoft Learn)",
    risk: (fqdns: string) => `Přijaté riziko: ${fqdns} odpovídají i registrům a úložištím jiných tenantů, což Microsoft uvádí jako cestu k úniku dat. Product owner to přijal 26. 10. 2026; potvrďte prosím písemně, že to přijímá i váš tým, s číslem změny.`,
    notIn: "V téhle sadě není: trezory klíčů, databáze a úložiště aplikací (privátní endpointy ve spoke síti), Docker Hub a interní systémy (níže).",
    state: "Stav",
    stateValue: (s: string, ref?: string) => (ref ? `${s} (číslo ${ref})` : s),
    systems: "6. INTERNÍ SYSTÉMY",
    systemsText: "Pravidla k interním systémům jsou samostatné žádosti: vlastník aplikace o každý systém požádá z portálu a pravidlo pak platí pro celé prostředí Container Apps.",
    systemsList: "V katalogu pro tohle prostředí:",
    systemsNone: "Katalog pro tohle prostředí zatím žádný systém nemá.",
    systemLine: (name: string, id: string, state: string) => `${name} (${id}): pravidlo ${state}`,
    after: "PO ZMĚNĚ",
    afterText: "Pošlete prosím čísla změn platform týmu. Správce platformy zapíše v portálu, že je stálá sada pravidel aktivní (egressBaseline); teprve potom provisioning přijme aplikace v tomhle režimu sítě. Platforma svou část (podsítě, a když VNet vytváří, i VNet a peering spoke → hub) nasadí v běhu platformní pipeline prostředí, po jeho schválení.",
    footer: (product: string, date: string, by?: string) => `Napsal ${product} ${date}${by ? ` pro ${by}` : ""}. Platforma sama žádné pravidlo firewallu nemění.`,
  },
} as const;

/** The network team's text for connecting one environment's connected mode to the hub, or a NetworkRequestError. */
export function hubConnectionRequest(input: HubConnectionInput): { text: string; fileName: string } {
  const mode = input.mode ?? "externalHybrid";
  const { env, config, hub } = environmentAndMode(input.instance, input.environment, mode);
  const L = HUB_TEXT[input.lang];
  const W = columnOf([L.platform, L.env, L.subscription, L.region, L.mode, L.cae, L.hubVnet, L.spokeToHub, L.hubToSpoke, L.remoteGateways, L.routeTable, L.defaultRoute, L.dnsServers, L.source, L.ruleType, L.state]);
  const prefix = input.instance.naming.prefix;
  const modeLabel = MODE_LABEL[input.lang][mode];
  const platformRg = platformResourceGroupName(prefix, env.name);
  const caeSubnet = cellCaeSubnetName(prefix, mode, env.name, DEFAULT_CELL_ID);
  const pepSubnet = privateEndpointSubnetName(prefix, mode, env.name);
  const created = config.vnet.create;
  const remote = created?.useRemoteGateways === true;
  const dns = config.dnsServers ?? [];
  const process = config.egressAllowListProcess?.trim();
  const width = Math.max(caeSubnet.length, pepSubnet.length) + 2;
  const subnetLines = [
    `    ${caeSubnet.padEnd(width)}${config.caeSubnetPrefix.padEnd(18)}${L.caeSubnet}`,
    `    ${pepSubnet.padEnd(width)}${config.privateEndpointSubnetPrefix.padEnd(18)}${L.pepSubnet}`,
  ];
  const baseline = config.egressBaseline;
  const systems = systemsOffered(input.instance, env.name, mode);
  const pageNames = [...new Set(EGRESS_BASELINE.flatMap((r) => r.sources.map((s) => s.page)))];
  const lines: string[] = [
    L.title(env.name, MODE_SHORT[input.lang][mode]),
    "",
    L.ask,
    process ? L.process(oneLine(process)) : L.noProcess,
    "",
    L.environment,
    ...rows(W, [
      [L.platform, L.platformValue(productOf(input.instance), prefix)],
      [L.env, `${env.name} (${KIND_LABEL[input.lang][env.kind] ?? env.kind})`],
      [L.subscription, env.subscriptionId],
      [L.region, env.region ?? input.instance.defaultRegion],
      [L.mode, modeLabel],
      [L.cae, L.caeValue(cellManagedEnvironmentName(prefix, mode, env.name, DEFAULT_CELL_ID), platformRg)],
    ]),
    "",
    L.vnet,
    ...(created ? [`  ${L.vnetCreate(spokeVnetName(prefix, mode, env.name), platformRg, created.addressSpace)}`] : [`  ${L.vnetExisting(config.vnet.existingVnetId ?? "?")}`, `  ${L.vnetExistingSubnets}`]),
    ...subnetLines,
    "",
    L.peering,
    ...(created
      ? rows(W, [
          [L.hubVnet, hub.vnetId],
          [L.spokeToHub, L.spokeToHubValue(hubPeeringName(prefix, mode, env.name), remote)],
          [L.hubToSpoke, L.hubToSpokeValue(remote)],
          [L.remoteGateways, L.remoteGatewaysValue(remote)],
        ])
      : [
          ...rows(W, [
            [L.hubVnet, hub.vnetId],
            [L.remoteGateways, L.remoteGatewaysExisting],
          ]),
          `  ${L.existingPeering}`,
        ]),
    "",
    L.route,
    ...rows(W, [
      [L.routeTable, L.routeTableValue(config.routeTableId)],
      [L.defaultRoute, L.defaultRouteValue(hub.firewallPrivateIp)],
    ]),
    `  ${L.routeNote(caeSubnet)}`,
    `  ${L.routeOpen}`,
    "",
    L.dns,
    ...rows(W, [[L.dnsServers, dns.length > 0 ? L.dnsServersCustom(dns.join(", ")) : L.dnsServersAzure]]),
    `  ${L.dnsMust}`,
    `    - ${L.dnsPublic}`,
    `    - ${L.dnsSystems}`,
    `    - ${L.dnsPrivate(privateDnsResourceGroupName(prefix, mode, env.name))}`,
    ...PRIVATE_DNS_ZONES.map((z) => `        ${z}`),
    `  ${dns.length > 0 ? L.dnsOpen : L.dnsAzure}`,
    "",
    L.baseline,
    ...rows(W, [
      [L.source, L.sourceValue(config.caeSubnetPrefix)],
      [L.ruleType, L.ruleTypeValue],
      [L.state, L.stateValue(BASELINE_LABEL[input.lang][baseline?.status ?? "notRequested"] ?? baseline?.status ?? "", baseline?.reference ? oneLine(baseline.reference) : undefined)],
    ]),
    ...EGRESS_BASELINE.flatMap((r) => [`    - ${r.purpose[input.lang]}${r.note ? ` (${r.note[input.lang]})` : ""}:`, `        ${r.fqdns.join(", ")}`]),
    `  ${L.risk(BASELINE_RISK_FQDNS.join(input.lang === "cs" ? " a " : " and "))}`,
    `  ${L.notIn}`,
    `  ${L.sources}: ${pageNames.join("; ")}`,
    "",
    L.systems,
    `  ${L.systemsText}`,
    ...(systems.length > 0 ? [`  ${L.systemsList}`, ...systems.map((s) => `    - ${L.systemLine(oneLine(s.name), s.id, RULE_LABEL[input.lang][firewallRuleOf(s, env.name, mode).status])}`)] : [`  ${L.systemsNone}`]),
    "",
    L.after,
    `  ${L.afterText}`,
    "",
    L.footer(productOf(input.instance), day(input.date, input.lang), input.requestedBy ? oneLine(input.requestedBy) : undefined),
    "",
  ];
  return { text: lines.join("\n"), fileName: `network-request-${prefix}-${env.name}-${MODE_ABBREVIATION[mode]}.txt` };
}
