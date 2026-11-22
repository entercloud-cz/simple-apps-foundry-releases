/**
 * The onboarding plan of an instance (ADR-0072): one machine-readable definition of every step, read by
 * `platform instance plan|status` (instance.sh plan|status), the runbook's step-by-step checklist
 * (docs/runbooks/onboard-instance.md, generated from it), the AI guide that `platform generate` writes into
 * platform-config, and the portal's setup wizard (package.json exports "./onboarding").
 *
 * Two phases:
 *   base   the base deployment, run with instance.sh by the platform team and the other teams
 *          (docs/runbooks/onboard-instance.md steps 1 to 10);
 *   setup  the initial platform configuration after it: the portal's setup wizard (Settings > Platform setup,
 *          ADR-0073), or an AI chat that follows the same steps. Its changes go into one pull request to
 *          instance.yaml at the end: the email of S01 and the settings of S02 to S05 together, with the steps
 *          confirmed or skipped (instance.yaml `setup`, SETUP_PROGRESS_KEYS). Only S01's test mail waits for the
 *          merge (and for Exchange).
 *
 * Step IDs (B01, S01, ...) are stable: they are never reused or renumbered, and the order is data (the list
 * order), so a step can move without a new ID. A test checks the IDs, the dependencies (they exist and come
 * earlier), the runbook anchors and that every title has English and Czech.
 *
 * Browser-safe on purpose: no Node imports (the portal bundles it). Keep it that way.
 */

export type Lang = "en" | "cs";
export const LANGS: readonly Lang[] = ["en", "cs"];

/** A text in the two shipped languages (English is the source). */
export interface Text {
  en: string;
  cs: string;
}

export const PLAN_FORMAT_VERSION = 1;

export type PhaseId = "base" | "setup";

export interface Phase {
  id: PhaseId;
  title: Text;
  description: Text;
}

export const PHASES: readonly Phase[] = [
  {
    id: "base",
    title: { en: "Base deployment", cs: "Základní nasazení" },
    description: {
      en: "instance.sh, step by step, by the platform team with the other teams",
      cs: "instance.sh krok za krokem, platformní tým spolu s ostatními týmy",
    },
  },
  {
    id: "setup",
    title: { en: "Initial platform configuration", cs: "Počáteční nastavení platformy" },
    description: {
      en: "after the base deployment: the portal's setup wizard, or an AI chat that follows the same steps; one pull request to instance.yaml at the end",
      cs: "po základním nasazení: průvodce nastavením v portálu, nebo chat s AI, který jde po stejných krocích; na konci jeden pull request do instance.yaml",
    },
  },
];

/** Who acts in a step. */
export type ActorId = "platformTeam" | "securityTeam" | "subscriptionOwners" | "networkTeam" | "identityTeam" | "adoAdmins" | "dnsTeam" | "exchangeAdmins";

export const ACTORS: Readonly<Record<ActorId, Text>> = {
  platformTeam: { en: "platform team", cs: "platformní tým" },
  securityTeam: { en: "security team", cs: "bezpečnostní tým" },
  subscriptionOwners: { en: "subscription owners", cs: "vlastníci předplatných" },
  networkTeam: { en: "network team", cs: "síťový tým" },
  identityTeam: { en: "identity team", cs: "tým identit" },
  adoAdmins: { en: "Azure DevOps organisation admins", cs: "správci organizace Azure DevOps" },
  dnsTeam: { en: "DNS team", cs: "tým DNS" },
  exchangeAdmins: { en: "Exchange admins", cs: "správci Exchange" },
};

/** What a step needs besides running its commands: a person approves or reviews. */
export type Gate = "pullRequest" | "pipelineApproval" | "adminConsent";

export const GATES: Readonly<Record<Gate, Text>> = {
  pullRequest: { en: "a pull request to platform-config, reviewed and completed", cs: "pull request do platform-config, zkontrolovaný a dokončený" },
  pipelineApproval: { en: "an approval of the pipeline run", cs: "schválení běhu pipeline" },
  adminConsent: { en: "the tenant's admin consent", cs: "souhlas správce za celý tenant" },
};

/** A condition under which a step applies at all; otherwise it is done ("not needed"). */
export type Condition = "managedNetwork" | "severalEnvironments" | "azureDnsZones" | "entraChangesPullRequest" | "portalWithoutHostName";

export const CONDITIONS: Readonly<Record<Condition, Text>> = {
  managedNetwork: {
    en: "only when an environment uses the managed network variant, the default of networkModes.externalOnly.network",
    cs: "jen když některé prostředí používá variantu sítě managed, tedy výchozí networkModes.externalOnly.network",
  },
  severalEnvironments: { en: "only when the instance has more than one environment", cs: "jen když má instance víc než jedno prostředí" },
  azureDnsZones: { en: "only when dns.zones has a zone with provider azureDns", cs: "jen když dns.zones obsahuje zónu s provider azureDns" },
  entraChangesPullRequest: {
    en: "only with approvals.entraChanges: pullRequest, the default",
    cs: "jen s approvals.entraChanges: pullRequest, což je výchozí",
  },
  portalWithoutHostName: {
    en: "only when the portal has no host name of its own (ADR-0071: portal.hostName \"\", or no managed Front Door profile or DNS zone for the host environment)",
    cs: "jen když portál nemá vlastní host name (ADR-0071: portal.hostName \"\", nebo hostitelské prostředí nemá spravovaný Front Door profil či DNS zónu)",
  },
};

/**
 * How `platform instance status` decides that a step is done (README of the CLI, "platform instance plan and
 * status"). `confirmed`: nothing in Azure, Azure DevOps or instance.yaml records it; the step counts as done once
 * a step that depends on it is done, and until then it waits on its actor while its dependents go on.
 */
export const CHECK_IDS = [
  "instance-valid",
  "confirmed",
  "login",
  "providers",
  "network-approvals",
  "dns-zones",
  "ado-projects",
  "ado-config",
  "core-tag",
  "bootstrap-host",
  "bootstrap-others",
  "dns-roles",
  "instance-principals",
  "deployment-entra-permissions",
  "ado-connections",
  "bootstrap-federation",
  "deployment-roles",
  "ado-pipeline",
  "ado-grants",
  "ado-policies",
  "entra-pull-request",
  "deployment-platform",
  "deployment-audit-alert",
  "deployment-portal",
  "deployment-portal-registration",
  "instance-portal",
  "portal-app",
  "portal-ready",
  "first-app",
  "email-setting",
  "setup-step",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Done when ... (English; the README of the CLI has the same table). */
export const CHECKS: Readonly<Record<CheckId, string>> = {
  "instance-valid": "instance.yaml passes platform validate instance",
  confirmed: "nothing records it: done once a step that depends on it is done; until then it waits on its actor and its dependents go on",
  login: "az is logged in to instance.yaml tenantId, and every environment subscription's resource providers can be read",
  providers: "no environment subscription lacks a resource provider of infra/README.md (subscription prerequisites)",
  "network-approvals": "portal.network.approvalReference is set, and every externalHybrid environment has egressBaseline.status active",
  "dns-zones": "every dns.zones zone with provider azureDns exists at its azureDnsZoneId",
  "ado-projects": "platform ado bootstrap plan --phase projects shows no create, update or blocked row",
  "ado-config": "platform ado bootstrap plan --phase config shows no create, update or blocked row",
  "core-tag": "platform ado bootstrap plan --phase core shows no create, update or blocked row, and core has the tag coreVersion",
  "bootstrap-host": "the deployment bootstrap-{prefix}-{host} succeeded",
  "bootstrap-others": "the deployment bootstrap-{prefix}-{env} succeeded in every other environment",
  "dns-roles": "each allowed environment's provisioning identity holds DNS Zone Contributor, Contributor or Owner on each Azure DNS zone or above",
  "instance-principals":
    "instance.yaml identities.entraProvisioningPrincipalId and portal.identityPrincipalId are the host bootstrap's outputs, and that instance.yaml is on platform-config's default branch",
  "deployment-entra-permissions": "the deployment entra-permissions in rg-{prefix}-entra succeeded",
  "ado-connections": "platform ado bootstrap plan --phase connections shows no create or update row, and reads back every connection's issuer and subject",
  "bootstrap-federation": "each environment's bootstrap was deployed with the federation (parameter federation) its service connections have now",
  "deployment-roles": "the deployment roles-{prefix} succeeded",
  "ado-pipeline":
    "platform ado bootstrap plan --phase pipeline finds every platform pipeline and shows no create, update or extra row (with approvals.entraChanges separate, no blocked row either)",
  "ado-grants": "platform ado bootstrap plan --phase grants shows no create, update or blocked row",
  "ado-policies": "platform ado bootstrap plan --phase policies shows no create, update or blocked row",
  "entra-pull-request": "platform ado bootstrap plan --phase connections and --phase pipeline show no create, update, extra or blocked row",
  "deployment-platform": "the deployment platform-{prefix}-{env} succeeded in every environment",
  "deployment-audit-alert": "the deployment entra-audit-alert next to the host's platform workspace (or instance.sh status --workspace) succeeded",
  "deployment-portal": "the deployment portal-{prefix}-{host} succeeded",
  "deployment-portal-registration": "the deployment entra-portal-{host} in rg-{prefix}-entra succeeded",
  "instance-portal": "instance.yaml portal.clientId is the registration's clientId, portal.apiBaseUrl is set, and that instance.yaml is on platform-config's default branch",
  "portal-app": "the portal deployment's output containerApp is set (pass 2: the Container App exists)",
  "portal-ready": "the portal answers 200 on /readyz at portal.apiBaseUrl, else at https:// and the portal deployment's portalFqdn",
  "first-app": "platform-config has an app definition apps/{slug}/app.yaml",
  "email-setting": "instance.yaml has notifications.email, and that instance.yaml is on platform-config's default branch",
  "setup-step":
    "instance.yaml setup.confirmed or setup.skipped lists the step (confirmed wins when both do), and that instance.yaml is on platform-config's default branch; a skipped step is done and shown as skipped",
};

/**
 * A command a person (or the AI guide, for them) runs. Placeholders: <host> (portal.hostEnvironment), <env> (each
 * environment the step names), <prefix>, <portal-url>, <portal-client-id> and <portal-object-id> (the portal
 * identity's application and object ID), <sender> (the sender mailbox), <scope> (the Exchange management scope's
 * name; PLACEHOLDER_DEFAULTS). `changes`: the command changes something (an --apply, a write); the AI guide runs it
 * only after the person's yes for that step.
 */
export interface Command {
  run: string;
  changes?: true;
}

/** A part of a step with its own actor (the setup phase's email: Exchange, then a pull request, then a test). */
export interface Task {
  title: Text;
  actor: ActorId;
  commands: readonly Command[];
  gates: readonly Gate[];
  /** The instance.yaml keys the task sets through a pull request (as the portal's Settings would). */
  instanceYaml?: readonly string[];
}

/** The portal's Settings sections that a setup step's cards are in, named as the portal names them. */
export type SettingsSectionId = "general" | "access" | "maintenance" | "security" | "notify" | "data" | "newApps" | "costs";

export const SETTINGS_SECTIONS: Readonly<Record<SettingsSectionId, Text>> = {
  general: { en: "General", cs: "Obecné" },
  access: { en: "Access & approvals", cs: "Přístupy a schvalování" },
  maintenance: { en: "Maintenance window", cs: "Okno údržby" },
  security: { en: "Security & scanning", cs: "Bezpečnost a skenování" },
  notify: { en: "Notifications", cs: "Notifikace" },
  data: { en: "Data services", cs: "Datové služby" },
  newApps: { en: "New apps", cs: "Nové aplikace" },
  costs: { en: "Costs & budgets", cs: "Náklady a rozpočty" },
};

/**
 * A card of the portal's Settings that a setup step shows, with the instance.yaml keys it edits (the portal's setting
 * fields, portal/shared/src/settings.ts). The portal's wizard shows the card by its `id`; a portal test checks that it
 * knows every card and that the titles and keys are the portal's. The AI guide shows the same keys with their values
 * and defaults.
 */
export interface SettingsCard {
  id: string;
  section: SettingsSectionId;
  /** The card's title as the portal shows it. */
  title: Text;
  keys: readonly string[];
}

export interface Step {
  /** Stable: B = base, S = setup; never reused. */
  id: string;
  phase: PhaseId;
  title: Text;
  actor: ActorId;
  /** The right the actor needs. */
  needs?: Text;
  commands: readonly Command[];
  /** A pipeline run the person starts in Azure DevOps (Run pipeline, on the default branch), if any. */
  pipeline?: string;
  /** What to do when it is no command (a request to another team, a step in the portal or Azure DevOps). */
  action?: Text;
  gates: readonly Gate[];
  /** The step's commands run once per environment (the portal host first). */
  forEach?: "environment" | "otherEnvironment";
  onlyWhen?: Condition;
  /** The detailed section, from the repository root: docs/runbooks/<file>.md#<anchor>. */
  runbook: string;
  dependsOn: readonly string[];
  done: CheckId;
  /** Whom the step waits on when another team has to act (blocked rows of a plan); default: the actor. */
  waitsOn?: ActorId;
  /** The instance.yaml keys the step sets (through a pull request). */
  instanceYaml?: readonly string[];
  tasks?: readonly Task[];
  /** A setup step: the Settings cards it shows, in order. */
  settings?: readonly SettingsCard[];
  /** A setup step a person may skip (instance.yaml setup.skipped): its values stay as they are. */
  skippable?: true;
}

/** instance.yaml keys of the setup phase's progress (ADR-0073): the IDs of the steps confirmed, and of those skipped. */
export const SETUP_PROGRESS_KEYS = { confirmed: "setup.confirmed", skipped: "setup.skipped" } as const;

/** What a placeholder stands for when nothing fills it: the Exchange management scope's suggested name. */
export const PLACEHOLDER_DEFAULTS: Readonly<Record<string, string>> = { scope: "SAF portal sender mailbox" };

const RUNBOOK = "docs/runbooks/onboard-instance.md";
const c = (run: string): Command => ({ run });
const apply = (run: string): Command => ({ run, changes: true });
/** A preview, then the same command with --apply. */
const previewThenApply = (run: string): Command[] => [c(run), apply(`${run} --apply`)];

const PROJECT_ADMIN: Text = { en: "Project Administrator of the platform project", cs: "Project Administrator platformního projektu" };
const OWNER_EACH: Text = { en: "Owner of each environment subscription", cs: "Owner každého předplatného prostředí" };
const SETUP_RUNBOOK = `${RUNBOOK}#11-the-initial-platform-configuration`;

/** What to do in a setup step S02 to S05: the portal's wizard, or the same edit by hand. */
function setupAction(id: string): Text {
  return {
    en: `in the portal: Settings > Platform setup, step ${id}: keep the values (confirm), change them or skip the step; or by hand: the step's keys and ${id} in setup.confirmed or setup.skipped, in the setup's one pull request (S01 to S05)`,
    cs: `v portálu: Nastavení > Nastavení platformy, krok ${id}: hodnoty ponech (potvrď), změň je, nebo krok přeskoč; nebo ručně: klíče kroku a ${id} v setup.confirmed nebo setup.skipped, v jednom pull requestu nastavení (kroky S01 až S05)`,
  };
}

const PLAN_STEPS: Step[] = [
  // --- runbook step 1: decide ----------------------------------------------------------------------
  {
    id: "B01",
    phase: "base",
    title: { en: "Write the decisions into instance.yaml and validate it", cs: "Zapiš rozhodnutí do instance.yaml a ověř ho" },
    actor: "platformTeam",
    commands: [c("platform validate instance instance.yaml")],
    gates: [],
    runbook: `${RUNBOOK}#1-decide`,
    dependsOn: [],
    done: "instance-valid",
  },
  {
    id: "B02",
    phase: "base",
    title: {
      en: "Get the security team's written decision on the network variant",
      cs: "Získej od bezpečnostního týmu písemné rozhodnutí o variantě sítě",
    },
    actor: "securityTeam",
    action: {
      en: "show them the residual risk of the managed variant (docs/architecture/data-services.md, network access by variant) and record their decision; vnet needs address space instead (B05)",
      cs: "ukaž jim zbytkové riziko varianty managed (docs/architecture/data-services.md, network access by variant) a zapiš jejich rozhodnutí; vnet místo toho potřebuje adresní prostor (B05)",
    },
    commands: [],
    gates: [],
    onlyWhen: "managedNetwork",
    runbook: `${RUNBOOK}#1-decide`,
    dependsOn: ["B01"],
    done: "confirmed",
  },
  // --- runbook step 2: customer prerequisites ------------------------------------------------------
  {
    id: "B03",
    phase: "base",
    title: { en: "Run the read-only preflight and clear what blocks", cs: "Spusť kontrolu předpokladů (jen čte) a odstraň, co blokuje" },
    actor: "platformTeam",
    needs: { en: "Reader on each environment subscription", cs: "Reader na každém předplatném prostředí" },
    commands: [c("instance.sh preflight")],
    gates: [],
    runbook: `${RUNBOOK}#2-customer-prerequisites`,
    dependsOn: ["B01"],
    done: "login",
  },
  {
    id: "B04",
    phase: "base",
    title: { en: "Register the resource providers in each environment subscription", cs: "Zaregistruj poskytovatele prostředků v každém předplatném prostředí" },
    actor: "subscriptionOwners",
    needs: { en: "Contributor or Owner on each environment subscription", cs: "Contributor nebo Owner na každém předplatném prostředí" },
    commands: previewThenApply("instance.sh providers"),
    gates: [],
    runbook: `${RUNBOOK}#2-customer-prerequisites`,
    dependsOn: ["B03"],
    done: "providers",
  },
  {
    id: "B05",
    phase: "base",
    title: {
      en: "Get the network team's approval of the address space, and of the hub connection for hybrid environments",
      cs: "Získej od síťového týmu schválení adresního prostoru a u hybridních prostředí i připojení k hubu",
    },
    actor: "networkTeam",
    action: {
      en: "send them the request (for an externalHybrid environment, the text this command prints) and record their approval references in instance.yaml",
      cs: "pošli jim žádost (pro prostředí externalHybrid text, který vypíše tento příkaz) a jejich čísla schválení zapiš do instance.yaml",
    },
    commands: [c("platform network request --config-dir . --env <env>")],
    gates: [],
    runbook: `${RUNBOOK}#2-customer-prerequisites`,
    dependsOn: ["B01"],
    done: "network-approvals",
    instanceYaml: ["portal.network.approvalReference", "environments[].networkModes.externalHybrid.egressBaseline"],
  },
  {
    id: "B06",
    phase: "base",
    title: {
      en: "Ask the identity team for the Graph consent, the portal's consent and the Entra groups",
      cs: "Požádej tým identit o souhlas pro Graph, souhlas pro portál a skupiny v Entra ID",
    },
    actor: "identityTeam",
    action: {
      en: "send the request: the Entra provisioning identity's Graph permissions (B16), the portal's delegated permissions (B28), the groups of platformAdmins and approvals.platformTeam",
      cs: "pošli žádost: oprávnění Graph pro identitu provisioningu v Entra (B16), delegovaná oprávnění portálu (B28), skupiny platformAdmins a approvals.platformTeam",
    },
    commands: [],
    gates: [],
    runbook: `${RUNBOOK}#2-customer-prerequisites`,
    dependsOn: ["B01"],
    done: "confirmed",
  },
  {
    id: "B07",
    phase: "base",
    title: {
      en: "Ask the Azure DevOps organisation admins for the organisation settings and the right to create projects",
      cs: "Požádej správce organizace Azure DevOps o nastavení organizace a právo zakládat projekty",
    },
    actor: "adoAdmins",
    action: {
      en: "send the request: Create new projects for you, the organisation settings, Microsoft-hosted parallelism, classic pipelines off",
      cs: "pošli žádost: právo Create new projects pro tebe, nastavení organizace, paralelní běhy Microsoft-hosted, klasické pipeline vypnout",
    },
    commands: [],
    gates: [],
    runbook: `${RUNBOOK}#2-customer-prerequisites`,
    dependsOn: ["B01"],
    done: "confirmed",
  },
  {
    id: "B08",
    phase: "base",
    title: { en: "Create the Azure DNS zones and have them delegated", cs: "Vytvoř zóny Azure DNS a nech je delegovat" },
    actor: "dnsTeam",
    needs: { en: "Contributor on each zone's resource group", cs: "Contributor na skupině prostředků každé zóny" },
    commands: previewThenApply("instance.sh dns"),
    gates: [],
    onlyWhen: "azureDnsZones",
    runbook: `${RUNBOOK}#2-customer-prerequisites`,
    dependsOn: ["B03"],
    done: "dns-zones",
  },
  // --- runbook step 3: the repositories ------------------------------------------------------------
  {
    id: "B09",
    phase: "base",
    title: { en: "Create the Azure DevOps projects", cs: "Založ projekty v Azure DevOps" },
    actor: "platformTeam",
    needs: { en: "Create new projects in the Azure DevOps organisation", cs: "oprávnění Create new projects v organizaci Azure DevOps" },
    commands: previewThenApply("instance.sh ado projects"),
    gates: [],
    runbook: `${RUNBOOK}#3-the-repositories`,
    dependsOn: ["B07"],
    done: "ado-projects",
    waitsOn: "adoAdmins",
  },
  {
    id: "B10",
    phase: "base",
    title: { en: "Create platform-config with its first commit", cs: "Založ repozitář platform-config s prvním commitem" },
    actor: "platformTeam",
    needs: PROJECT_ADMIN,
    commands: [c("platform validate instance instance.yaml"), ...previewThenApply("instance.sh ado config")],
    gates: [],
    runbook: `${RUNBOOK}#3-the-repositories`,
    dependsOn: ["B09"],
    done: "ado-config",
  },
  {
    id: "B11",
    phase: "base",
    title: { en: "Take the pinned core release into the platform project's core", cs: "Převezmi připnutou verzi core do repozitáře core platformního projektu" },
    actor: "platformTeam",
    needs: PROJECT_ADMIN,
    commands: previewThenApply("instance.sh core"),
    gates: [],
    runbook: `${RUNBOOK}#3-the-repositories`,
    dependsOn: ["B09"],
    done: "core-tag",
  },
  // --- runbook step 4: identities ------------------------------------------------------------------
  {
    id: "B12",
    phase: "base",
    title: { en: "Bootstrap the portal host environment (pass 1)", cs: "Spusť bootstrap hostitelského prostředí portálu (1. průchod)" },
    actor: "platformTeam",
    needs: { en: "Owner of the host environment's subscription", cs: "Owner předplatného hostitelského prostředí" },
    commands: previewThenApply("instance.sh bootstrap <host>"),
    gates: [],
    runbook: `${RUNBOOK}#4-identities-azure-side`,
    dependsOn: ["B04"],
    done: "bootstrap-host",
  },
  {
    id: "B13",
    phase: "base",
    title: { en: "Bootstrap every other environment (pass 1)", cs: "Spusť bootstrap každého dalšího prostředí (1. průchod)" },
    actor: "platformTeam",
    needs: OWNER_EACH,
    commands: previewThenApply("instance.sh bootstrap <env>"),
    gates: [],
    forEach: "otherEnvironment",
    onlyWhen: "severalEnvironments",
    runbook: `${RUNBOOK}#4-identities-azure-side`,
    dependsOn: ["B12"],
    done: "bootstrap-others",
  },
  {
    id: "B14",
    phase: "base",
    title: {
      en: "Give the provisioning identities DNS Zone Contributor on their Azure DNS zones (custom domains behind Front Door)",
      cs: "Dej identitám provisioningu roli DNS Zone Contributor na jejich zónách Azure DNS (vlastní domény za Front Door)",
    },
    actor: "dnsTeam",
    needs: { en: "Owner or User Access Administrator on the zones", cs: "Owner nebo User Access Administrator na zónách" },
    commands: [c("instance.sh dns")],
    gates: [],
    onlyWhen: "azureDnsZones",
    runbook: `${RUNBOOK}#9-email-dns-and-front-door`,
    dependsOn: ["B08", "B12", "B13"],
    done: "dns-roles",
  },
  {
    id: "B15",
    phase: "base",
    title: { en: "Put the identities' principal IDs into instance.yaml", cs: "Zapiš ID identit do instance.yaml" },
    actor: "platformTeam",
    commands: previewThenApply("instance.sh sync"),
    gates: ["pullRequest"],
    runbook: `${RUNBOOK}#4-identities-azure-side`,
    dependsOn: ["B10", "B12"],
    done: "instance-principals",
    instanceYaml: ["identities.entraProvisioningPrincipalId", "portal.identityPrincipalId"],
  },
  {
    id: "B16",
    phase: "base",
    title: {
      en: "Grant the Entra provisioning identity its Microsoft Graph permissions",
      cs: "Přiděl identitě pro provisioning v Entra její oprávnění v Microsoft Graph",
    },
    actor: "identityTeam",
    needs: { en: "Privileged Role Administrator or Global Administrator", cs: "Privileged Role Administrator nebo Global Administrator" },
    commands: previewThenApply("instance.sh entra-permissions"),
    gates: ["adminConsent"],
    runbook: `${RUNBOOK}#4-identities-azure-side`,
    dependsOn: ["B06", "B12"],
    done: "deployment-entra-permissions",
  },
  {
    id: "B17",
    phase: "base",
    title: {
      en: "Add the portal identity, and the automation identity, to the Azure DevOps organisation",
      cs: "Přidej identitu portálu a identitu automatizace do organizace Azure DevOps",
    },
    actor: "adoAdmins",
    action: {
      en: "Organization settings > Users > Add users: `id-<prefix>-portal` with Basic (and `id-<prefix>-ado-automation`, unless whoever runs B22 may add users)",
      cs: "Organization settings > Users > Add users: `id-<prefix>-portal` s Basic (a `id-<prefix>-ado-automation`, pokud ten, kdo spouští B22, nesmí přidávat uživatele)",
    },
    needs: { en: "organisation administrator in Azure DevOps", cs: "správce organizace v Azure DevOps" },
    commands: [],
    gates: [],
    runbook: `${RUNBOOK}#4-identities-azure-side`,
    dependsOn: ["B12"],
    done: "confirmed",
  },
  // --- runbook step 5: service connections, then bootstrap pass 2 ---------------------------------
  {
    id: "B18",
    phase: "base",
    title: {
      en: "Create the service connections and the platform environments in Azure DevOps",
      cs: "Vytvoř v Azure DevOps servisní připojení a platformní prostředí",
    },
    actor: "platformTeam",
    needs: PROJECT_ADMIN,
    commands: previewThenApply("instance.sh ado connections"),
    gates: [],
    runbook: `${RUNBOOK}#5-service-connections-then-bootstrap-pass-2`,
    dependsOn: ["B10", "B11", "B12", "B13"],
    done: "ado-connections",
  },
  {
    id: "B19",
    phase: "base",
    title: { en: "Bootstrap pass 2 in every environment, the portal host first", cs: "Spusť 2. průchod bootstrapu ve všech prostředích, hostitelské první" },
    actor: "platformTeam",
    needs: OWNER_EACH,
    commands: [c("instance.sh bootstrap <env> --pass 2"), apply("instance.sh bootstrap <env> --pass 2 --apply --remove-lock")],
    gates: [],
    forEach: "environment",
    runbook: `${RUNBOOK}#5-service-connections-then-bootstrap-pass-2`,
    dependsOn: ["B18"],
    done: "bootstrap-federation",
  },
  // --- runbook step 6: roles, pipelines, grants, policies ------------------------------------------
  {
    id: "B20",
    phase: "base",
    title: { en: "Deploy the custom roles", cs: "Nasaď vlastní role" },
    actor: "platformTeam",
    needs: { en: "Owner or User Access Administrator on every environment subscription", cs: "Owner nebo User Access Administrator na každém předplatném prostředí" },
    commands: previewThenApply("instance.sh roles"),
    gates: [],
    runbook: `${RUNBOOK}#6-roles-pipelines-grants-policies`,
    dependsOn: ["B04"],
    done: "deployment-roles",
  },
  {
    id: "B21",
    phase: "base",
    title: { en: "Register the platform pipelines", cs: "Zaregistruj platformní pipeline" },
    actor: "platformTeam",
    needs: PROJECT_ADMIN,
    commands: previewThenApply("instance.sh ado pipeline"),
    gates: [],
    runbook: `${RUNBOOK}#6-roles-pipelines-grants-policies`,
    dependsOn: ["B18"],
    done: "ado-pipeline",
  },
  {
    id: "B22",
    phase: "base",
    title: {
      en: "Grant the automation and portal identities their Azure DevOps rights",
      cs: "Přiděl identitě automatizace a identitě portálu práva v Azure DevOps",
    },
    actor: "platformTeam",
    needs: PROJECT_ADMIN,
    commands: previewThenApply("instance.sh ado grants"),
    gates: [],
    runbook: `${RUNBOOK}#6-roles-pipelines-grants-policies`,
    dependsOn: ["B17", "B21"],
    done: "ado-grants",
    waitsOn: "adoAdmins",
  },
  {
    id: "B23",
    phase: "base",
    title: { en: "Protect platform-config's default branch with branch policies", cs: "Ochraň výchozí větev platform-config zásadami větve" },
    actor: "platformTeam",
    needs: { en: "Edit policies on platform-config", cs: "oprávnění Edit policies na platform-config" },
    commands: previewThenApply("instance.sh ado policies"),
    gates: [],
    runbook: `${RUNBOOK}#6-roles-pipelines-grants-policies`,
    dependsOn: ["B21"],
    done: "ado-policies",
  },
  {
    id: "B24",
    phase: "base",
    title: {
      en: "Let the reviewed pull request approve Entra changes: the connections and pipelines again",
      cs: "Ať změny v Entra schvaluje zkontrolovaný pull request: znovu připojení a pipeline",
    },
    actor: "platformTeam",
    needs: PROJECT_ADMIN,
    commands: [...previewThenApply("instance.sh ado connections"), ...previewThenApply("instance.sh ado pipeline")],
    gates: [],
    onlyWhen: "entraChangesPullRequest",
    runbook: `${RUNBOOK}#6-roles-pipelines-grants-policies`,
    dependsOn: ["B23"],
    done: "entra-pull-request",
  },
  // --- runbook step 7: the platform environments ---------------------------------------------------
  {
    id: "B25",
    phase: "base",
    title: {
      en: "Run each environment's platform pipeline, the portal host first, and approve it",
      cs: "Spusť platformní pipeline každého prostředí, hostitelské první, a schval ji",
    },
    actor: "platformTeam",
    action: {
      en: "run the pipeline `\\platform\\platform-<env>` on the default branch and approve its run on `platform-<env>`, the portal host first; a second run must say up-to-date",
      cs: "spusť pipeline `\\platform\\platform-<env>` na výchozí větvi a schval její běh na `platform-<env>`, hostitelské prostředí první; druhý běh musí říct up-to-date",
    },
    needs: { en: "an approver of platform-<env>, from approvals.platformTeam", cs: "schvalovatel platform-<env>, z approvals.platformTeam" },
    commands: [],
    pipeline: "\\platform\\platform-<env>",
    gates: ["pipelineApproval"],
    forEach: "environment",
    runbook: `${RUNBOOK}#7-the-platform-environments`,
    dependsOn: ["B02", "B05", "B15", "B19", "B20", "B21"],
    done: "deployment-platform",
  },
  {
    id: "B26",
    phase: "base",
    title: { en: "Deploy the Entra audit alert on the Entra provisioning identity", cs: "Nasaď auditní upozornění na identitu pro provisioning v Entra" },
    actor: "identityTeam",
    needs: { en: "Contributor on the workspace's resource group, with the platform team", cs: "Contributor na skupině prostředků pracovního prostoru, spolu s platformním týmem" },
    commands: previewThenApply("instance.sh audit-alert --action-group <the identity team's action group>"),
    gates: [],
    runbook: `${RUNBOOK}#7-the-platform-environments`,
    dependsOn: ["B16", "B25"],
    done: "deployment-audit-alert",
  },
  // --- runbook step 8: the portal ------------------------------------------------------------------
  {
    id: "B27",
    phase: "base",
    title: {
      en: "Run the host's platform pipeline again: the portal's first pass, for its Container App's address",
      cs: "Spusť platformní pipeline hostitelského prostředí znovu: první průchod portálu kvůli adrese jeho Container App",
    },
    actor: "platformTeam",
    action: {
      en: "run the pipeline `\\platform\\platform-<host>` again and approve the portal's pass 1",
      cs: "spusť pipeline `\\platform\\platform-<host>` znovu a schval první průchod portálu",
    },
    needs: { en: "an approver of platform-<host>", cs: "schvalovatel platform-<host>" },
    commands: [],
    pipeline: "\\platform\\platform-<host>",
    gates: ["pipelineApproval"],
    runbook: `${RUNBOOK}#8-the-portal`,
    dependsOn: ["B25"],
    onlyWhen: "portalWithoutHostName",
    done: "deployment-portal",
  },
  {
    id: "B28",
    phase: "base",
    title: { en: "Register the portal in Entra ID (the tenant's admin consent)", cs: "Zaregistruj portál v Entra ID (souhlas správce za tenant)" },
    actor: "identityTeam",
    needs: { en: "Cloud Application Administrator or Application Administrator", cs: "Cloud Application Administrator nebo Application Administrator" },
    commands: previewThenApply("instance.sh portal-registration"),
    gates: ["adminConsent"],
    runbook: `${RUNBOOK}#8-the-portal`,
    // With its own host name (ADR-0071) the redirect URI is known from instance.yaml: no portal deployment first.
    dependsOn: ["B06", "B12", "B27"],
    done: "deployment-portal-registration",
  },
  {
    id: "B29",
    phase: "base",
    title: { en: "Put portal.clientId and portal.apiBaseUrl into instance.yaml", cs: "Zapiš portal.clientId a portal.apiBaseUrl do instance.yaml" },
    actor: "platformTeam",
    commands: previewThenApply("instance.sh sync"),
    gates: ["pullRequest"],
    runbook: `${RUNBOOK}#8-the-portal`,
    dependsOn: ["B22", "B28"],
    done: "instance-portal",
    instanceYaml: ["portal.clientId", "portal.apiBaseUrl"],
  },
  {
    id: "B30",
    phase: "base",
    title: {
      en: "Approve the host's platform pipeline run that the merge starts: the portal itself",
      cs: "Schval běh platformní pipeline hostitelského prostředí, který merge spustí: samotný portál",
    },
    actor: "platformTeam",
    action: {
      en: "complete the pull request of B29; it starts `\\platform\\platform-<host>`: approve its run on `platform-<host>` (a new portal gets pass 1 and pass 2 in it)",
      cs: "dokonči pull request z B29; spustí `\\platform\\platform-<host>`: schval jeho běh na `platform-<host>` (nový portál v něm dostane první i druhý průchod)",
    },
    needs: { en: "an approver of platform-<host>", cs: "schvalovatel platform-<host>" },
    commands: [],
    pipeline: "\\platform\\platform-<host>",
    gates: ["pipelineApproval"],
    runbook: `${RUNBOOK}#8-the-portal`,
    dependsOn: ["B25", "B29"],
    done: "portal-app",
  },
  {
    id: "B31",
    phase: "base",
    title: { en: "Check that the portal answers at its address", cs: "Ověř, že portál odpovídá na své adrese" },
    actor: "platformTeam",
    commands: [c("curl --fail --silent --show-error <portal-url>/readyz")],
    gates: [],
    runbook: `${RUNBOOK}#8-the-portal`,
    dependsOn: ["B30"],
    done: "portal-ready",
  },
  // --- runbook step 10: the first app --------------------------------------------------------------
  {
    id: "B32",
    phase: "base",
    title: { en: "Request a first app in the portal and follow it to its deployments", cs: "Požádej v portálu o první aplikaci a sleduj ji až k nasazení" },
    actor: "platformTeam",
    action: {
      en: "in the portal: New app, a small one; then its pull request, the provisioning run and its first deployments",
      cs: "v portálu: Nová aplikace, nějaká malá; pak její pull request, běh provisioningu a první nasazení",
    },
    commands: [],
    gates: ["pullRequest", "pipelineApproval"],
    runbook: `${RUNBOOK}#10-the-first-app`,
    dependsOn: ["B31"],
    done: "first-app",
  },
  // --- setup: the portal's setup wizard, or an AI chat ---------------------------------------------
  {
    id: "S01",
    phase: "setup",
    title: { en: "The portal's email: a Microsoft 365 shared mailbox the portal sends as", cs: "E-maily portálu: sdílená schránka Microsoft 365, ze které portál posílá" },
    actor: "platformTeam",
    commands: [],
    gates: ["pullRequest"],
    runbook: "docs/runbooks/portal-email.md#steps",
    dependsOn: ["B31"],
    done: "email-setting",
    instanceYaml: ["notifications.email"],
    tasks: [
      {
        title: {
          en: "Exchange: the sender mailbox, and the portal identity's right to send as it (RBAC for Applications)",
          cs: "Exchange: schránka odesílatele a právo identity portálu odesílat za ni (RBAC for Applications)",
        },
        actor: "exchangeAdmins",
        commands: [
          apply('New-Mailbox -Shared -Name "SAF portal" -PrimarySmtpAddress <sender>'),
          apply('New-ServicePrincipal -AppId <portal-client-id> -ObjectId <portal-object-id> -DisplayName "SAF portal (id-<prefix>-portal)"'),
          apply("New-ManagementScope -Name \"<scope>\" -RecipientRestrictionFilter \"PrimarySmtpAddress -eq '<sender>'\""),
          apply('New-ManagementRoleAssignment -App <portal-client-id> -Role "Application Mail.Send" -CustomResourceScope "<scope>"'),
          c("Test-ServicePrincipalAuthorization -Identity <portal-client-id> -Resource <sender>"),
        ],
        gates: [],
      },
      {
        title: {
          en: "notifications.email in instance.yaml, in the setup's one pull request with S02 to S05 (it doesn't wait for Exchange): Settings > Platform setup (or Settings > Notifications) in the portal, or the same edit by hand",
          cs: "notifications.email v instance.yaml, v jednom pull requestu nastavení spolu s kroky S02 až S05 (na Exchange nečeká): v portálu Nastavení > Nastavení platformy (nebo Nastavení > Notifikace), nebo stejná úprava ručně",
        },
        actor: "platformTeam",
        commands: [c("platform validate instance instance.yaml")],
        gates: ["pullRequest"],
        instanceYaml: ["notifications.email"],
      },
      {
        title: {
          en: "After the merge, send the test mail; only it waits for Exchange (30 minutes to 2 hours after its commands): Settings > Platform setup, or Settings > Notifications > Send a test email",
          cs: "Po merge pošli testovací e-mail; jen ten čeká na Exchange (30 minut až 2 hodiny po jeho příkazech): Nastavení > Nastavení platformy, nebo Nastavení > Notifikace > Poslat testovací e-mail",
        },
        actor: "platformTeam",
        commands: [],
        gates: [],
      },
    ],
    settings: [{ id: "email", section: "notify", title: { en: "How the portal sends email", cs: "Jak portál posílá e-maily" }, keys: ["notifications.email"] }],
  },
  // S02 to S05 (ADR-0073): confirmed as they are, changed, or skipped; one pull request at the end, the email of S01
  // included, which also records the decisions in instance.yaml setup.confirmed and setup.skipped.
  {
    id: "S02",
    phase: "setup",
    title: { en: "Basics and look: the portal's name, languages, currency, logo and colour", cs: "Základy a vzhled: název portálu, jazyky, měna, logo a barva" },
    actor: "platformTeam",
    action: setupAction("S02"),
    commands: [],
    gates: ["pullRequest"],
    runbook: SETUP_RUNBOOK,
    dependsOn: ["B31"],
    done: "setup-step",
    skippable: true,
    settings: [
      { id: "general", section: "general", title: { en: "Name, language and currency", cs: "Název, jazyk a měna" }, keys: ["productName", "locale.defaultLanguage", "locale.languages", "locale.currency"] },
      { id: "branding", section: "general", title: { en: "Logo and brand colour", cs: "Logo a barva značky" }, keys: ["branding.logoUrl", "branding.primaryColor"] },
    ],
  },
  {
    id: "S03",
    phase: "setup",
    title: {
      en: "People and approvals: the platform admins, the platform team (who approves production), how Entra changes are approved",
      cs: "Lidé a schvalování: správci platformy, platformní tým (schvaluje produkci), jak se schvalují změny v Entra",
    },
    actor: "platformTeam",
    action: setupAction("S03"),
    commands: [],
    gates: ["pullRequest"],
    runbook: SETUP_RUNBOOK,
    dependsOn: ["B31"],
    done: "setup-step",
    skippable: true,
    settings: [
      { id: "admins", section: "access", title: { en: "Who manages the platform", cs: "Kdo spravuje platformu" }, keys: ["platformAdmins", "approvals.platformTeam"] },
      { id: "approvals", section: "access", title: { en: "Approvals", cs: "Schvalování" }, keys: ["approvals.entraChanges", "approvals.allowSelfApproval"] },
    ],
  },
  {
    id: "S04",
    phase: "setup",
    title: {
      en: "Operations: the maintenance window, old app images, audit log and monitoring",
      cs: "Provoz: okno údržby, staré obrazy aplikací, auditní záznam a monitorování",
    },
    actor: "platformTeam",
    action: setupAction("S04"),
    commands: [],
    gates: ["pullRequest"],
    runbook: SETUP_RUNBOOK,
    dependsOn: ["B31"],
    done: "setup-step",
    skippable: true,
    settings: [
      { id: "maintenanceWindow", section: "maintenance", title: { en: "When the platform does its maintenance", cs: "Kdy platforma dělá údržbu" }, keys: ["maintenance.window.days", "maintenance.window.start", "maintenance.window.hours"] },
      { id: "maintenanceChecks", section: "maintenance", title: { en: "Checks and upgrades", cs: "Kontroly a aktualizace" }, keys: ["maintenance.driftCheckDays", "maintenance.requiredUpgradeDays", "maintenance.upgrades"] },
      {
        id: "registryRetention",
        section: "maintenance",
        title: { en: "Old app images", cs: "Staré obrazy aplikací" },
        keys: ["maintenance.registryRetention.mode", "maintenance.registryRetention.days", "maintenance.registryRetention.keepLatest"],
      },
      { id: "audit", section: "security", title: { en: "Audit log", cs: "Auditní záznam" }, keys: ["observability.auditRetentionDays"] },
      { id: "monitoring", section: "notify", title: { en: "Monitoring", cs: "Monitorování" }, keys: ["observability.logRetentionDays", "observability.defaultAlerts"] },
    ],
  },
  {
    id: "S05",
    phase: "setup",
    title: {
      en: "What apps are offered: databases and their sizes, backups, the new-app wizard's basic mode, costs and budgets, lifecycle rules",
      cs: "Co se aplikacím nabízí: databáze a jejich velikosti, zálohy, základní režim průvodce novou aplikací, náklady a rozpočty, pravidla životního cyklu",
    },
    actor: "platformTeam",
    action: setupAction("S05"),
    commands: [],
    gates: ["pullRequest"],
    runbook: SETUP_RUNBOOK,
    dependsOn: ["B31"],
    done: "setup-step",
    skippable: true,
    settings: [
      { id: "engines", section: "data", title: { en: "What apps can store", cs: "Co si aplikace mohou ukládat" }, keys: ["data.postgres.enabled", "data.azureSql.enabled", "data.storage.enabled", "data.postgres.cpuCreditAlert"] },
      { id: "sizes", section: "data", title: { en: "Database sizes", cs: "Velikosti databází" }, keys: ["data.postgres.sizes", "data.azureSql.sizes"] },
      { id: "backups", section: "data", title: { en: "Database backups", cs: "Zálohy databází" }, keys: ["data.backup.retentionDaysProd", "data.backup.retentionDaysNonprod", "data.backup.geoRedundantProd"] },
      {
        id: "fileProtection",
        section: "data",
        title: { en: "File storage protection", cs: "Ochrana úložiště souborů" },
        keys: [
          "data.storage.protection.softDeleteDaysProd",
          "data.storage.protection.softDeleteDaysNonprod",
          "data.storage.protection.pointInTimeRestore",
          "data.storage.vaultedBackup.offeredInProd",
          "data.storage.vaultedBackup.retentionDays",
        ],
      },
      { id: "basicMode", section: "newApps", title: { en: "Basic mode of the new-app wizard", cs: "Základní režim průvodce novou aplikací" }, keys: ["newApps.basicMode.enabled"] },
      {
        id: "basicChoices",
        section: "newApps",
        title: { en: "What basic mode sets up", cs: "Co základní režim nastaví" },
        keys: [
          "newApps.basicMode.networkMode",
          "newApps.basicMode.stack",
          "newApps.basicMode.databaseEngine",
          "newApps.basicMode.databaseSize",
          "newApps.basicMode.storage",
          "newApps.basicMode.companyDomain",
        ],
      },
      { id: "capacity", section: "newApps", title: { en: "Default capacity", cs: "Výchozí výkon" }, keys: ["newApps.capacity.size", "newApps.capacity.maxReplicas"] },
      { id: "budgets", section: "costs", title: { en: "Budgets", cs: "Rozpočty" }, keys: ["budgets.mode", "budgets.defaultMonthlyAmount", "budgets.notifyAtPercent", "budgets.forecastNotifyAtPercent"] },
      { id: "costData", section: "costs", title: { en: "Cost data", cs: "Data o nákladech" }, keys: ["costs.enabled", "costs.costType"] },
      { id: "fx", section: "costs", title: { en: "Currency conversion", cs: "Převod měn" }, keys: ["costs.fx"] },
      {
        id: "lifecycle",
        section: "security",
        title: { en: "Lifecycle rules", cs: "Pravidla životního cyklu" },
        keys: ["lifecycle.maxBuildAgeDays", "lifecycle.criticalCveFixDays", "lifecycle.highCveFixDays", "lifecycle.recertificationMonths", "lifecycle.unusedAfterDaysWithoutRequests"],
      },
    ],
  },
];

export const STEPS: readonly Step[] = PLAN_STEPS.map(withSetupKeys);

/** A setup step's instance.yaml keys: its cards' keys, and for S02 to S05 the progress (SETUP_PROGRESS_KEYS). */
function withSetupKeys(step: Step): Step {
  if (!step.settings || step.done !== "setup-step") return step;
  return { ...step, instanceYaml: [...step.settings.flatMap((card) => card.keys), SETUP_PROGRESS_KEYS.confirmed, SETUP_PROGRESS_KEYS.skipped] };
}

/**
 * A setup step's title in two parts, "name: what": the name for a short list (the portal's wizard), the rest for its
 * page. Every setup step's title has both (a test checks it).
 */
export function titleParts(step: Step, lang: Lang): { name: string; detail: string } {
  const t = step.title[lang];
  const i = t.indexOf(": ");
  return i > 0 ? { name: t.slice(0, i), detail: t.slice(i + 2) } : { name: t, detail: "" };
}

/** The steps a person confirms or skips (check setup-step), in plan order: S02 to S05. */
export function setupDecisionSteps(): Step[] {
  return STEPS.filter((s) => s.done === "setup-step");
}

export function stepById(id: string): Step | undefined {
  return STEPS.find((s) => s.id === id);
}

export function stepsOf(phase: PhaseId): Step[] {
  return STEPS.filter((s) => s.phase === phase);
}

export function phaseById(id: PhaseId): Phase {
  return PHASES.find((p) => p.id === id)!;
}

/** Everyone who acts in a step: its actor, then its tasks' actors, each once. */
export function actorsOf(step: Step): ActorId[] {
  const out: ActorId[] = [step.actor];
  for (const t of step.tasks ?? []) if (!out.includes(t.actor)) out.push(t.actor);
  return out;
}

/** The steps that depend on `id`, directly or through others. */
export function dependentsOf(id: string): Step[] {
  const out: Step[] = [];
  const seen = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of STEPS) {
      if (!seen.has(s.id) && s.dependsOn.some((d) => seen.has(d))) {
        seen.add(s.id);
        out.push(s);
        grew = true;
      }
    }
  }
  return STEPS.filter((s) => out.includes(s));
}
