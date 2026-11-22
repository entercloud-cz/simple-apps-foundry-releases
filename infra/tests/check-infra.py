#!/usr/bin/env python3
"""Offline checks for infra/** (no Azure access, no login).

1. `az bicep lint` of every .bicep file under infra/: zero errors, zero warnings.
2. `az bicep build` of every entry template; every compiled template (and every nested
   module template) stays within the ARM limit of 64 user-defined functions.
3. `bicep snapshot` of every example .bicepparam (the deployment engine evaluates names,
   conditions and fail() guards locally), plus negative variants that must fail.
   The delivery parameter files (infra/app/delivery/) are evaluated with fixture values in
   SAF_RELEASE_JSON / SAF_NAMES_JSON: delivery mode can't be changed by input, bad input fails.
   The provisioning parameter files (infra/app/provisioning/, infra/entra/provisioning/) are
   evaluated with the example inputs `platform provisioning inputs` writes (SAF_LZ_JSON,
   SAF_RELEASE_JSON, SAF_ENTRA_JSON, SAF_FRONTDOOR_JSON): extra keys change nothing, bad types and
   values fail.
   The platform pipeline's parameter files (infra/platform/pipeline/, ADR-0043) too, with the
   inputs `platform environment inputs` and `portal-inputs` write (SAF_ENVIRONMENT_JSON,
   SAF_PORTAL_JSON, SAF_PLATFORM_NAMES_JSON): the nonprod input predicts exactly the resources of
   the hand-written nonprod example, pass 1 (no digest) creates no job; the portal input (pass 2)
   predicts exactly the resources of the hand-written portal example with digest and client ID,
   its pass 1 exactly those of the example's pass 1 (no Container App); platform-names.bicep gives
   the deployment, registry, jobs, the three custom role GUIDs, the portal's names and the
   environment vaults (as environment.bicep names them, another vaultGeneration other names).
   The onboarding parameter files (infra/platform/instance/, ADR-0066) with the inputs `platform
   instance inputs` writes (SAF_INSTANCE_JSON, infra/platform/instance/examples/): bootstrap of the host
   (pass 2) and of nonprod (pass 1), roles, Graph permissions, portal registration and Entra audit alert
   each predict exactly the resources of their hand-written example (tags aside); extra keys change
   nothing, a missing input and the bootstrap's input guards fail.
   The delivery names.bicep's environmentVault (ADR-0060) is each landing-zone example's output
   environmentKeyVaultName for that example's mode, the other variant for the other mode, and null
   without the inputs it needs. Its entraApplicationUniqueName (ADR-0061) is null without
   incarnation, {prefix}-{slug}-{env} for 0 and --i{n} above it; the Entra registration's application
   has that uniqueName (incarnation 0 and 2, their app role IDs disjoint), and SAF_ENTRA_JSON without
   incarnation, or a negative one, fails.
4. Custom roles (infra/platform/roles.bicep): no Microsoft.Authorization/*, no delete, no
   listSecrets, no Key Vault action, no dataActions (ADR-0005, ADR-0021, US04.01). Platform Job
   Secret Writer (ADR-0035): exactly its six job actions, the environment subscriptions as
   assignable scopes, never in the provisioning identity's unrestricted role set (only for the
   Entra provisioning identity, ADR-0043).
5. No hand-built resource names outside infra/modules/naming/naming.bicep (US03.01). No
   `import *` from naming.bicep or types.bicep outside infra/tests/, and adding an unused exported
   type, variable or function to types.bicep / naming.bicep leaves every compiled entry template
   byte-identical: an unused definition would change the template hash of every importer, which
   change detection turns into needless redeploys and Entra approvals.
6. Platform identities bootstrap (infra/platform/bootstrap.bicep, ADR-0031, ADR-0043): the RBAC
   Administrator assignment carries the "constrain roles" ABAC condition whose unrestricted role
   set is exactly types.builtInRoles + the two delivery roles (never Owner, User Access
   Administrator or RBAC Administrator), plus Log Analytics Reader and Cost Management Reader for
   the portal identity only, Platform Job Secret Writer for the Entra provisioning identity only
   (instancePrincipals outside the portal host, this deployment's own identities in it, {} there) and
   Container Registry Repository Contributor (types.registryPurgeRole, ADR-0059) for this deployment's
   provisioning identity only (the identities module's output, in both clauses);
   every role an infra/app or infra/platform template assigns is in that set, the limited roles
   only to their principal (compiled JSON and example snapshots); the ReadOnly lock depends on every identity, federated
   credential and role assignment of its module; federated credentials only with federation,
   the ADO automation and Entra provisioning identities only with instanceIdentities.
   Entra deployments (ADR-0033, ADR-0063): rg-{prefix}-entra, one records group rg-{prefix}-entra-{env}
   per environment of entraEnvironments and the custom role Entra Deployment Operator only with
   instanceIdentities; its actions are exactly deployments/* and resource group read (no notActions,
   no dataActions), assignable only at those groups, assigned only there and only to the Entra
   provisioning identity, which has no other role; never in the ABAC role set; entraEnvironments must
   name environmentName in the host, be [] elsewhere and list no environment twice.
7. The registry purge role (ADR-0059): the landing zone of a build environment assigns Container
   Registry Repository Contributor on its own registry in the app resource group to its deployer
   (`[deployer().objectId]`) exactly once, a promotion environment's nowhere, and outputs
   registryPurgeRole accordingly; the role is outside builtInRoles.
   The landing zone outputs containerAppFqdn = {containerApp}.{CAE defaultDomain}. With
   portalIdentityPrincipalId (ADR-0037) it assigns Reader to that principal at the app resource
   group and nothing else to it; with '' it assigns nothing more; a non-GUID fails.
8. Graph permissions of the Entra provisioning identity (infra/platform/entra-permissions.bicep,
   ADR-0023): exactly the four app role assignments, always on the existing Microsoft Graph
   service principal, always to the principal from the parameter; no other Graph resource.
9. Platform registry and kvset jobs (infra/platform/environment.bicep, ADR-0035), in both
   environment examples (pass 2) and their pass-1 variants (empty digest): the registry
   (Basic, no admin user, no anonymous pull, ABAC mode) with Repository Reader for the kvset
   identity only; one kvset job per enabled CAE with exactly the kvset identity, manual trigger,
   one replica, no retry, no ingress, no secrets, the saf-jobs digest, argument kvset, exactly
   SAF_VAULT_URI / SAF_VAULT_AUDIENCE / AZURE_CLIENT_ID, and the vault of the CAE's variant
   (managed network -> public, VNet-based -> private); Platform Job Secret Writer only on each
   job, only to entraProvisioningPrincipalId, which holds no other role; pass 1 creates no job
   and no such assignment.
10. Portal (infra/platform/portal.bicep, ADR-0036, ADR-0025), pass 1 (the example without
   SAF_PORTAL_IMAGE_DIGEST) and pass 2 (with digest and client ID): everything in
   rg-{prefix}-portal-{env} except one Container Registry Repository Reader assignment for
   id-{prefix}-portal on the host environment's platform registry (and nowhere else); a VNet
   peered to nothing whose CAE subnet egresses through the portal NAT Gateway; the portal's own
   vault and sql zones linked to the portal VNet only; the CAE in the CAE subnet; the portal
   database (ADR-0070, Azure SQL): Entra-only (azureADOnlyAuthentication on the server and as its
   own child), public network access disabled, TLS 1.2, the database `portal` on a provisioned
   Standard SKU with explicit backup storage redundancy and PITR retention, the portal identity
   (its client ID as the sid) as its only Entra administrator, no firewall rule, its private
   endpoint in the portal's private-endpoint subnet registered in the portal's sql zone, audit
   to the environment workspace; pass 2 only: the
   Container App with only the portal identity, the saf-portal digest pulled with that identity,
   external HTTPS-only ingress on 8080, probes, min one replica and exactly the env var
   contract (database host and name included, no database user). A missing `database`, a retention outside
   7-35, a SKU that isn't provisioned Standard (serverless, another tier) and a size outside
   1-1024 GB fail. Pass 2 without a client ID, a bad digest, a hub route table and a foreign tenant
   fail. ADR-0025 amendment 2026-11-14 (through the pipeline's portal.bicepparam): the host's
   private environment vault gets the portal-side endpoint pep-{vault}-portal (automatic
   connection, the portal's vault zone), the public one none; with the SMTP password secret
   present, Key Vault Secrets User for id-{prefix}-portal on that one secret and
   SAF_SMTP_PASSWORD_VAULT_URI naming the vault (empty otherwise, also with the secret absent);
   an existing secret without a name, a bad secret name or vault variant fail. The bootstrap creates id-{prefix}-portal (portal host only) without any role.
11. Portal registration (infra/entra/portal-registration.bicep, ADR-0036, ADR-0040): no
   parameter defaults; both declarations of the application with uniqueName {prefix}-portal-{env},
   no password or key credentials, no web platform, groups claim ApplicationGroup, v2 access
   tokens, the one scope access_as_user, the CAE redirect URI (plus localhost only on a nonprod
   host) and exactly the five delegated Graph scopes (openid, profile, offline_access,
   User.Read.All, GroupMember.Read.All) plus Azure Key Vault user_impersonation (ADR-0025) in
   requiredResourceAccess; no app roles; exactly one federated
   identity credential `portal-obo` with the tenant's v2.0 issuer, the portal identity's principal
   ID as subject and the one audience api://AzureADTokenExchange; its service principal with
   appRoleAssignmentRequired false; exactly three consent grants (Graph with exactly those five
   scopes, Key Vault with user_impersonation only, its own access_as_user); the default role assigned on its own service principal to the
   two platform groups (once when they are the same group). Dev redirect URIs on a prod host,
   non-localhost dev URIs, non-GUID groups, a CAE domain with a scheme, a bad environment name, a
   foreign tenant, a non-GUID or missing portal identity principal fail.
12. Managed Front Door profile (infra/modules/frontdoor/profile.bicep via infra/platform/environment.bicep,
   ADR-0010), in both environment examples and variants (frontDoor null or omitted, kind defaults,
   Premium, WAF off): exactly one profile afd-{prefix}-{env} with its one endpoint fde-{prefix}-{env},
   both in the platform resource group at location global, the SKU as configured or by environment kind
   (Standard in nonprod, Premium in prod); the WAF policy waf{prefix}{env} with the profile's SKU, mode
   Detection or Prevention as configured (kind default: detection in nonprod, prevention in prod),
   no custom rules and managed rule sets only on Premium (Default Rule Set 2.1 Block + Bot Manager 1.1);
   the security policy secp-{prefix}-{env} associating the WAF with the endpoint and nothing else on
   /*; a diagnostic setting of all logs to the environment workspace; the portal identity's Reader on
   the profile (its custom domains in the portal); no origin groups, origins, routes or custom domains
   (those are per app, frontdoor.bicep); with WAF off no WAF and no security policy; without
   a profile no Microsoft.Cdn or WAF resource and every other resource unchanged. A profile of another
   environment, managed rule sets on Standard, an unknown SKU or WAF mode and a missing environment fail.
13. One app on its custom domain through the managed Front Door (infra/app/frontdoor.bicep, deployment
   fd-{slug}-{env} in the platform resource group, ADR-0010 amended 2026-11-01), in the example and
   variants (manual DNS, the zone ID in lower case, a two-label subdomain, prod with a hybrid CAE):
   only per-app objects in the environment's profile (never the profile, endpoint, WAF policy or the
   environment's security policy): the origin group without health probe, the origin
   ca-{slug}.{CAE default domain} as host and host header over HTTPS with the certificate name check,
   the custom domain with a Front Door-managed certificate and TLS 1.2 (azureDnsZone only with a zone),
   the route serving only the custom domain (linkToDefaultDomain Disabled) on /*, HTTP and HTTPS with
   the redirect, forwarding HTTPS only, no cacheConfiguration and no rule sets; with a zone exactly the
   TXT _dnsauth.{sub} (validation token) and the CNAME {sub} (endpoint host) in that zone, both with the
   metadata saf-app = {slug}, saf-env = {env} (ADR-0052), without one
   no DNS record; the outputs (frontDoorId: the profile's, read by provisioning). No security policy and no reference to a WAF policy, neither in the
   compiled template (nested modules included) nor in any snapshot: a WAF policy can be linked through
   only one security policy per profile, and secp-{prefix}-{env} links the environment's (sandbox,
   2026-11-01). A host outside the zone or at its apex, a zone in another subscription, a private zone
   or no zone ID, a wildcard, upper-case, scheme or trailing-dot host, a two-label host, another
   resource group or deployment name, an unknown network mode, a missing dnsZoneId and the removed
   wafEnabled parameter fail.
14. Portal-side private endpoint of an app vault (infra/app/portal-vault-endpoint.bicep, deployment
   pep-portal-{slug}-{env} in the portal resource group, ADR-0025), in the example (prod vault, portal
   host prod, same subscription) and variants (a nonprod vault in another subscription, External only
   in the VNet variant, a subscription ID in upper case, generation 1): exactly the endpoint
   pep-{vault}-portal and its DNS zone group, nothing else (compiled template: no nested deployment,
   no role assignment); the endpoint in the portal VNet's private-endpoint subnet with the NIC
   nic-pep-{vault}-portal and exactly one connection, group `vault`, to the app vault named as the
   landing zone names it (same name as the landing-zone example of that environment); automatic
   (privateLinkServiceConnections) for a vault in the deployment's subscription, a manual request
   (manualPrivateLinkServiceConnections) for one in another subscription; the zone group registers in
   the portal resource group's privatelink.vaultcore.azure.net only; the outputs. The provisioning
   parameter file (infra/app/provisioning/portal-endpoint.bicepparam) gives the same deployment as
   the example. A managed-network app, another resource group, deployment name or portal environment,
   a non-GUID subscription, a bad environment name, an unknown network mode and a missing location fail.
15. Ingress lock-down behind the managed Front Door (infra/app/release.bicep, ADR-0010 amended
   2026-11-11, FD-3): 157 backend ranges (the sandbox count) through the provisioning and the delivery
   parameter file become exactly one Allow rule afd-backend-{n} per range, in order, with
   FRONT_DOOR_ID; the compiled template stays under ARM's 4 MB; frontDoor.mode none writes no rule.
16. Unit manifest infra/app/units.json (ADR-0048 section 2): for each provisioning unit (lz, entra,
   release, frontdoor, pep, ado) its fingerprint is the sha256 of its compiled templates (`_generator`
   metadata removed at every level, canonical JSON), the raw bytes of its .bicepparam files and its
   `revision`, each part length-prefixed. The run fails when the manifest is stale;
   `--update-units` rewrites it (a changed fingerprint gets `since: unreleased`, the release step
   tools/scripts/release-units.mjs replaces that with the version). Bump a unit's `revision` by hand
   when a script changes what the unit does in Azure while its template and inputs stay the same.
17. App availability isolation (ADR-0052, AGENTS.md hard rule 10). Compiled: in the app-scoped templates
   (landing-zone.bicep with landing-zone-resources.bicep and its modules, release.bicep, frontdoor.bicep,
   portal-vault-endpoint.bicep) every resource of a shared type (CAE, jobs, Front Door profile, endpoint,
   security policy, WAF policy, VNet, subnet, NSG, route table, NAT gateway, public IP, private and public
   DNS zone, Log Analytics workspace; outside the app RG also Key Vault, its secrets and registries) is
   `existing`, and every write outside the app's resource group is a module or resource of
   ISOLATION_OUTSIDE_WRITES (each with its reason; a deployment there derives its name from the app's).
   Snapshots of the examples of app A (hotel-inventory) and of the fixtures of app B (hotelinventory,
   infra/tests/isolation/, confusable slug and host) in the same environments: every predicted resource
   is in the app RG or matches a pattern built from slug, environment, host and naming (the Joiner role
   on the CAE, the role on easyauth-{slug}, the role on the app's own registry of promoteFrom, og-, orig-,
   route-{slug}-{env}, cd-{host}, the zone's CNAME and _dnsauth TXT of the host, pep-{vault}-portal with
   its zone group), and A's and B's outside writes are disjoint except ISOLATION_EXPECTED_SHARED (the
   non-injective cd-{host}, which `platform validate app` rejects).
18. The landing zone's prepare pass of a network mode change (landing-zone.bicep `modeChange`, ADR-0060
   decision 4), on variants of both landing-zone examples (nonprod: managed-network External only, case A;
   prod: externalOnlyNetwork vnet, case B; also with an existing hybrid spoke): into externalHybrid from
   the managed network it is the steady hybrid landing zone except that public network access of the data
   services and the app vault stays on, with the managed network's firewall rules; out of externalHybrid to
   the managed network exactly the steady External-only one; in case B the steady target landing zone with
   the source mode's endpoints (source spoke and DNS zones) and public access off. Always the delivery
   identity's Joiner on the target CAE only, the Easy Auth role on the target variant's vault, every
   resource within the app's isolation allow-list (17). The provisioning parameter file passes modeChange
   through; modeChange from the same mode, from internalOnly, another phase, a missing modeChange in the
   input and hybridExistingVnetId for externalOnly in the steady state fail. The data modules take
   publicNetworkAccess explicitly; false without an endpoint fails.

Usage: python3 infra/tests/check-infra.py [--update-units]   (Azure CLI with Bicep >= 0.46, Python 3.10+)
       --update-units only rewrites infra/app/units.json (builds the unit templates, no other check).
The naming matrix has its own script: infra/tests/check-naming.py.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
INFRA = REPO / "infra"
TENANT = "00000000-0000-0000-0000-000000000001"
NONPROD_SUB = "00000000-0000-0000-0000-00000000a001"
PROD_SUB = "00000000-0000-0000-0000-00000000b001"

ENTRY_TEMPLATES = [
    INFRA / "platform" / "environment.bicep",
    INFRA / "platform" / "roles.bicep",
    INFRA / "platform" / "bootstrap.bicep",
    INFRA / "platform" / "entra-permissions.bicep",
    INFRA / "platform" / "entra-audit-alert.bicep",
    INFRA / "platform" / "portal.bicep",
    INFRA / "app" / "landing-zone.bicep",
    INFRA / "app" / "release.bicep",
    INFRA / "app" / "frontdoor.bicep",
    INFRA / "app" / "portal-vault-endpoint.bicep",
    INFRA / "app" / "delivery" / "names.bicep",
    INFRA / "platform" / "pipeline" / "platform-names.bicep",
    INFRA / "entra" / "app-registration.bicep",
    INFRA / "entra" / "portal-registration.bicep",
]

# example -> snapshot arguments
EXAMPLES = {
    "platform/examples/contoso-nonprod.bicepparam": ["--subscription-id", NONPROD_SUB],
    "platform/examples/contoso-prod.bicepparam": ["--subscription-id", PROD_SUB],
    "platform/examples/contoso-roles.bicepparam": ["--subscription-id", PROD_SUB],
    "platform/examples/contoso-bootstrap-nonprod.bicepparam": ["--subscription-id", NONPROD_SUB],
    "platform/examples/contoso-bootstrap-prod.bicepparam": ["--subscription-id", PROD_SUB],
    "platform/examples/contoso-entra-permissions.bicepparam":
        ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-entra"],
    "platform/examples/contoso-portal.bicepparam": ["--subscription-id", PROD_SUB],
    "platform/examples/contoso-entra-audit-alert.bicepparam":
        ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-platform-prod"],
    "app/examples/hotel-inventory-nonprod.lz.bicepparam": ["--subscription-id", NONPROD_SUB],
    "app/examples/hotel-inventory-prod.lz.bicepparam": ["--subscription-id", PROD_SUB],
    "app/examples/hotel-inventory-nonprod.release.bicepparam":
        ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-app-hotel-inventory-nonprod"],
    "app/examples/hotel-inventory-prod.release.bicepparam":
        ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-app-hotel-inventory-prod"],
    "app/examples/hotel-inventory-nonprod.frontdoor.bicepparam":
        ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-platform-nonprod",
         "--deployment-name", "fd-hotel-inventory-nonprod"],
    "app/examples/hotel-inventory-prod.portal-endpoint.bicepparam":
        ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-portal-prod",
         "--deployment-name", "pep-portal-hotel-inventory-prod"],
    "entra/examples/hotel-inventory-nonprod.entra.bicepparam":
        ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-app-hotel-inventory-nonprod"],
    "entra/examples/contoso-portal-prod.bicepparam": ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-entra"],
}

# The database block of the portal example (contoso-portal.bicepparam), removed by a negative case.
PORTAL_DATABASE_BLOCK = """param database = {
  size: {
    skuName: 'S0'
    storageGb: 250
  }
  backupRetentionDays: 35
  backupStorageRedundancy: 'Geo'
}
"""

# (label, example to copy, text replacements, expected message fragment)
NEGATIVE = [
    ("internalOnly is rejected", "platform/examples/contoso-nonprod.bicepparam",
     [("param networkModes = {", "param networkModes = {\n  internalOnly: {}")], "internalOnly is not available"),
    ("managed rule sets need Premium", "platform/examples/contoso-nonprod.bicepparam",
     [("managedRuleSets: false", "managedRuleSets: true")], "managed rule sets need the Premium tier"),
    ("hybrid needs a hub", "platform/examples/contoso-nonprod.bicepparam",
     [("param hub = {\n  vnetId: '/subscriptions/00000000-0000-0000-0000-00000000f001/resourceGroups/rg-network-hub/"
       "providers/Microsoft.Network/virtualNetworks/vnet-hub-westeurope'\n  firewallPrivateIp: '10.0.1.4'\n}",
       "param hub = null")], "externalHybrid needs environments[].hub"),
    ("one relational database", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("  storage: {", "  azureSql: {\n    skuName: 'S0'\n    storageGb: 250\n    backupStorageRedundancy: 'Local'\n  }\n  storage: {")],
     "one relational database per app"),
    ("owner and deputy differ", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("principalId: '00000000-0000-0000-0000-00000000e002'", "principalId: '00000000-0000-0000-0000-00000000e001'")],
     "owner and deputy must be different principals"),
    ("developers unique", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param developers = [\n  {\n    principalId: '00000000-0000-0000-0000-00000000e003'\n    principalType: 'Group'\n  }\n]",
       "param developers = [\n  {\n    principalId: '00000000-0000-0000-0000-00000000e003'\n    principalType: 'Group'\n  }\n"
       "  {\n    principalId: '00000000-0000-0000-0000-00000000e003'\n    principalType: 'Group'\n  }\n]")],
     "developers must not list the same principal twice"),
    ("landing zone retention at least 7 (PostgreSQL)", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param backupRetentionDays = 7\n", "param backupRetentionDays = 6\n")], "minimum allowable value is 7"),
    ("landing zone portal principal is a GUID", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'", "param portalIdentityPrincipalId = 'id-contoso-portal'")],
     "portalIdentityPrincipalId must be empty or a GUID"),
    # ADR-0060: a prepare pass belongs to a change of mode, and only externalOnly <-> externalHybrid.
    ("landing zone mode change from the same mode", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param modeChange = null", "param modeChange = {\n  phase: 'prepare'\n  fromNetworkMode: 'externalOnly'\n}")],
     "modeChange.fromNetworkMode must differ from networkMode"),
    ("landing zone mode change from internalOnly", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param modeChange = null", "param modeChange = {\n  phase: 'prepare'\n  fromNetworkMode: 'internalOnly'\n}")],
     "'externalHybrid' | 'externalOnly'"),
    ("landing zone mode change phase is prepare", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param modeChange = null", "param modeChange = {\n  phase: 'final'\n  fromNetworkMode: 'externalHybrid'\n}")],
     "'prepare'"),
    ("landing zone hybrid VNet only for externalHybrid", "app/examples/hotel-inventory-nonprod.lz.bicepparam",
     [("param hybridExistingVnetId = null", "param hybridExistingVnetId = '/subscriptions/00000000-0000-0000-0000-00000000a001/"
       "resourceGroups/rg-network-nonprod/providers/Microsoft.Network/virtualNetworks/vnet-spoke-apps-nonprod'")],
     "hybridExistingVnetId applies to externalHybrid only"),
    ("reserved env var", "app/examples/hotel-inventory-nonprod.release.bicepparam",
     [("name: 'LOG_LEVEL'", "name: 'DATABASE_HOST'")], "platform-reserved names: DATABASE_HOST"),
    ("custom domain behind Front Door", "app/examples/hotel-inventory-prod.release.bicepparam",
     [("param customDomains = []", "param customDomains = [\n  {\n    name: 'hotel-inventory.contoso.com'\n  }\n]")],
     "no ACA-bound custom domain"),
    ("digest format", "app/examples/hotel-inventory-nonprod.release.bicepparam",
     [("'sha256:0000000000000000000000000000000000000000000000000000000000000000'", "'latest'")], "image.digest must be"),
    ("Entra redirect host without wildcard", "entra/examples/hotel-inventory-nonprod.entra.bicepparam",
     [("'hotel-inventory-test.contoso.com'", "'*.contoso.com'")], "hosts must be plain host names"),
    ("Entra assignment to an unknown role", "entra/examples/hotel-inventory-nonprod.entra.bicepparam",
     [("role: 'Admin'", "role: 'Owner'")], "references a role that is not in appRoles"),
    # A retired role's first deployment (isEnabled false, ADR-0033 amended 2026-11-11) declares no
    # assignment to it.
    ("Entra assignment to a disabled role", "entra/examples/hotel-inventory-nonprod.entra.bicepparam",
     [("description: 'Can manage the app.'", "description: 'Can manage the app.'\n    isEnabled: false")],
     "references a disabled role"),
    ("ADO automation federation needs instanceIdentities", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("param instanceIdentities = true", "param instanceIdentities = false")],
     "federation.adoAutomation needs instanceIdentities = true"),
    ("Entra federation needs instanceIdentities", "platform/examples/contoso-bootstrap-nonprod.bicepparam",
     [("param federation = {}", "param federation = {\n  entra: {\n    issuer: 'https://login.microsoftonline.com/"
       "00000000-0000-0000-0000-000000000001/v2.0'\n    subject: '/eid1/c/pub/t/00000000-0000-0000-0000-00000000d001/a/"
       "00000000-0000-0000-0000-00000000d002/sc/00000000-0000-0000-0000-00000000d003/00000000-0000-0000-0000-00000000d006'\n  }\n}")],
     "federation.entra needs instanceIdentities = true"),
    ("bootstrap outside the host needs instancePrincipals", "platform/examples/contoso-bootstrap-nonprod.bicepparam",
     [("  portal: '00000000-0000-0000-0000-00000000e102'\n", "")],
     "instancePrincipals needs portal and entraProvisioning as GUIDs outside the portal host subscription"),
    ("bootstrap instancePrincipals are GUIDs", "platform/examples/contoso-bootstrap-nonprod.bicepparam",
     [("entraProvisioning: '00000000-0000-0000-0000-00000000d101'", "entraProvisioning: 'id-contoso-entra-provisioning'")],
     "instancePrincipals needs portal and entraProvisioning as GUIDs"),
    ("bootstrap in the host takes no instancePrincipals", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("param instancePrincipals = {}", "param instancePrincipals = {\n  portal: '00000000-0000-0000-0000-00000000e102'\n}")],
     "instancePrincipals must be {} in the portal host subscription"),
    # ADR-0063: the Entra records groups of every environment, in the portal host subscription only.
    ("bootstrap in the host names its own environment's Entra group", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("  'nonprod'\n  'prod'\n", "  'nonprod'\n")],
     "entraEnvironments must list every environment of the instance"),
    ("bootstrap outside the host has no Entra groups", "platform/examples/contoso-bootstrap-nonprod.bicepparam",
     [("param entraEnvironments = []", "param entraEnvironments = [\n  'nonprod'\n]")],
     "entraEnvironments must be [] outside the portal host subscription"),
    ("bootstrap Entra groups once per environment", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("  'nonprod'\n  'prod'\n", "  'nonprod'\n  'prod'\n  'prod'\n")],
     "entraEnvironments lists an environment twice"),
    ("bootstrap Entra groups take environment names", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("  'nonprod'\n  'prod'\n", "  'Non-Prod'\n  'prod'\n")],
     "naming: invalid environment name"),
    ("Entra audit alert principal is a GUID", "platform/examples/contoso-entra-audit-alert.bicepparam",
     [("'00000000-0000-0000-0000-00000000d101'", "'id-contoso-entra-provisioning'")],
     "entraProvisioningPrincipalId must be a GUID"),
    ("Entra audit alert scope is a workspace", "platform/examples/contoso-entra-audit-alert.bicepparam",
     [("Microsoft.OperationalInsights/workspaces/log-contoso-prod", "Microsoft.Insights/components/appi-contoso")],
     "workspaceResourceId must be the resource ID of a Log Analytics workspace"),
    ("Entra permissions principal is a GUID", "platform/examples/contoso-entra-permissions.bicepparam",
     [("'00000000-0000-0000-0000-00000000d101'", "'id-contoso-entra-provisioning'")],
     "entraProvisioningPrincipalId must be a GUID"),
    ("Entra permissions principal GUID characters", "platform/examples/contoso-entra-permissions.bicepparam",
     [("'00000000-0000-0000-0000-00000000d101'", "'00000000-0000-0000-0000_00000000d10z'")],
     "entraProvisioningPrincipalId must be a GUID"),
    ("jobs digest format", "platform/examples/contoso-nonprod.bicepparam",
     [("param platformJobsImageDigest = 'sha256:", "param platformJobsImageDigest = 'latest")],
     "platformJobsImageDigest must be empty (pass 1) or sha256:<64 lowercase hex>"),
    ("jobs digest length", "platform/examples/contoso-prod.bicepparam",
     [("param platformJobsImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
       "param platformJobsImageDigest = 'sha256:000000000000000000000000000000000000000000000000000000000000000'")],
     "platformJobsImageDigest must be empty (pass 1) or sha256:<64 lowercase hex>"),
    ("jobs digest hex", "platform/examples/contoso-prod.bicepparam",
     [("param platformJobsImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
       "param platformJobsImageDigest = 'sha256:000000000000000000000000000000000000000000000000000000000000000A'")],
     "platformJobsImageDigest must be empty (pass 1) or sha256:<64 lowercase hex>"),
    ("environment Entra principal is a GUID", "platform/examples/contoso-nonprod.bicepparam",
     [("param entraProvisioningPrincipalId = '00000000-0000-0000-0000-00000000d101'",
       "param entraProvisioningPrincipalId = 'id-contoso-entra-provisioning'")],
     "entraProvisioningPrincipalId must be a GUID"),
    ("environment Entra principal not empty in pass 1", "platform/examples/contoso-prod.bicepparam",
     [("param platformJobsImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'",
       "param platformJobsImageDigest = ''"),
      ("param entraProvisioningPrincipalId = '00000000-0000-0000-0000-00000000d101'", "param entraProvisioningPrincipalId = ''")],
     "entraProvisioningPrincipalId must be a GUID"),
    ("environment portal principal is empty or a GUID", "platform/examples/contoso-nonprod.bicepparam",
     [("param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'",
       "param portalIdentityPrincipalId = 'id-contoso-portal'")],
     "portalIdentityPrincipalId must be empty or a GUID"),
    ("portal hub route table needs the peering", "platform/examples/contoso-portal.bicepparam",
     [("  privateEndpointSubnetPrefix: '10.40.1.0/24'\n", "  privateEndpointSubnetPrefix: '10.40.1.0/24'\n  routeTableId: "
       "'/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-network-prod/providers/Microsoft.Network/"
       "routeTables/rt-to-firewall'\n")],
     "portal.network.routeTableId is not available in this core version"),
    ("portal tenant is the deployment's", "platform/examples/contoso-portal.bicepparam",
     [("param tenantId = '00000000-0000-0000-0000-000000000001'", "param tenantId = '00000000-0000-0000-0000-000000000002'")],
     "is not the tenant of this deployment"),
    ("portal ADO organisation URL is https", "platform/examples/contoso-portal.bicepparam",
     [("organizationUrl: 'https://dev.azure.com/contoso'", "organizationUrl: 'http://dev.azure.com/contoso'")],
     "azureDevOps.organizationUrl must be an https:// URL"),
    # The portal API rejects these at startup (portal/api/src/settings.ts) and the container would
    # crash-loop, so portal.bicep must stop them first.
    ("portal database is required", "platform/examples/contoso-portal.bicepparam", [(PORTAL_DATABASE_BLOCK, "")],
     'missing an assignment in the params file: "database"'),
    ("portal database retention at most 35", "platform/examples/contoso-portal.bicepparam",
     [("  backupRetentionDays: 35\n", "  backupRetentionDays: 36\n")], "database.backupRetentionDays must be 7-35"),
    ("portal database retention at least 7", "platform/examples/contoso-portal.bicepparam",
     [("  backupRetentionDays: 35\n", "  backupRetentionDays: 6\n")], "database.backupRetentionDays must be 7-35"),
    # ADR-0070: a provisioned Standard SKU only, never serverless or another tier.
    ("portal database serverless SKU", "platform/examples/contoso-portal.bicepparam",
     [("    skuName: 'S0'\n", "    skuName: 'GP_S_Gen5_1'\n")], "database.size.skuName must be a provisioned Standard SKU"),
    ("portal database Basic tier", "platform/examples/contoso-portal.bicepparam",
     [("    skuName: 'S0'\n", "    skuName: 'Basic'\n")], "database.size.skuName must be a provisioned Standard SKU"),
    ("portal database size above the Standard maximum", "platform/examples/contoso-portal.bicepparam",
     [("    storageGb: 250\n", "    storageGb: 2048\n")], "database.size.storageGb must be 1-1024"),
    ("portal database backup redundancy is one of four", "platform/examples/contoso-portal.bicepparam",
     [("  backupStorageRedundancy: 'Geo'\n", "  backupStorageRedundancy: 'RA-GRS'\n")], "'Geo' | 'GeoZone' | 'Local' | 'Zone'"),
    ("portal ADO organisation URL without query", "platform/examples/contoso-portal.bicepparam",
     [("organizationUrl: 'https://dev.azure.com/contoso'", "organizationUrl: 'https://dev.azure.com/contoso?y'")],
     "azureDevOps.organizationUrl must be an https:// URL without query or fragment"),
    ("portal ADO organisation URL without fragment", "platform/examples/contoso-portal.bicepparam",
     [("organizationUrl: 'https://dev.azure.com/contoso'", "organizationUrl: 'https://dev.azure.com/contoso#top'")],
     "azureDevOps.organizationUrl must be an https:// URL without query or fragment"),
    ("portal ADO branch without spaces", "platform/examples/contoso-portal.bicepparam",
     [("platformConfigDefaultBranch: 'main'", "platformConfigDefaultBranch: 'main branch'")],
     "azureDevOps.platformConfigDefaultBranch must be a short branch name"),
    ("portal ADO branch is short", "platform/examples/contoso-portal.bicepparam",
     [("platformConfigDefaultBranch: 'main'", "platformConfigDefaultBranch: 'refs/heads/main'")],
     "azureDevOps.platformConfigDefaultBranch must be a short branch name"),
    ("portal ADO branch without ..", "platform/examples/contoso-portal.bicepparam",
     [("platformConfigDefaultBranch: 'main'", "platformConfigDefaultBranch: 'release/../main'")],
     "azureDevOps.platformConfigDefaultBranch must be a short branch name"),
    ("portal ADO branch without empty segment", "platform/examples/contoso-portal.bicepparam",
     [("platformConfigDefaultBranch: 'main'", "platformConfigDefaultBranch: 'release//main'")],
     "azureDevOps.platformConfigDefaultBranch must be a short branch name"),
    ("portal registration: dev redirect URI on a prod host", "entra/examples/contoso-portal-prod.bicepparam",
     [("param devRedirectUris = []", "param devRedirectUris = [\n  'http://localhost:5173/'\n]")],
     "devRedirectUris are allowed only when the portal host environment is of kind nonprod"),
    ("portal registration: dev redirect URI not localhost", "entra/examples/contoso-portal-prod.bicepparam",
     [("param environmentKind = 'prod'", "param environmentKind = 'nonprod'"),
      ("param devRedirectUris = []", "param devRedirectUris = [\n  'https://portal-dev.contoso.com/'\n]")],
     "devRedirectUris must be http://localhost:{port}/ URIs"),
    ("portal registration: group is a GUID", "entra/examples/contoso-portal-prod.bicepparam",
     [("param platformTeamGroupId = '00000000-0000-0000-0000-00000000c002'", "param platformTeamGroupId = 'sg-platform-team'")],
     "platformAdminsGroupId and platformTeamGroupId must be GUIDs"),
    ("portal registration: host name without scheme", "entra/examples/contoso-portal-prod.bicepparam",
     [("param portalHostName = '", "param portalHostName = 'https://")],
     "portalHostName must be a plain lowercase host name"),
    ("portal registration: host name in lower case", "entra/examples/contoso-portal-prod.bicepparam",
     [("param portalHostName = 'portal.contoso.com'", "param portalHostName = 'Portal.contoso.com'")],
     "portalHostName must be a plain lowercase host name"),
    ("portal registration: environment name", "entra/examples/contoso-portal-prod.bicepparam",
     [("param environmentName = 'prod'", "param environmentName = 'Prod'")], "naming: invalid environment name"),
    ("portal registration: tenant is the deployment's", "entra/examples/contoso-portal-prod.bicepparam",
     [("param tenantId = '00000000-0000-0000-0000-000000000001'", "param tenantId = '00000000-0000-0000-0000-000000000002'")],
     "is not the tenant of this deployment"),
    ("portal registration: OBO principal is a GUID", "entra/examples/contoso-portal-prod.bicepparam",
     [("param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'", "param portalIdentityPrincipalId = 'id-contoso-portal'")],
     "portalIdentityPrincipalId must be a GUID"),
    ("portal registration: OBO principal is required", "entra/examples/contoso-portal-prod.bicepparam",
     [("param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'\n", "")],
     'missing an assignment in the params file: "portalIdentityPrincipalId"'),
    ("federation issuer is https", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("issuer: 'https://login", "issuer: 'http://login")], "federation issuers must be https:// URLs"),
    ("federation subject not empty", "platform/examples/contoso-bootstrap-prod.bicepparam",
     [("subject: '/eid1/c/pub/t/00000000-0000-0000-0000-00000000d001/a/00000000-0000-0000-0000-00000000d002/sc/"
       "00000000-0000-0000-0000-00000000d003/00000000-0000-0000-0000-00000000d004'", "subject: ' '")],
     "federation subjects must not be empty"),
]

FORBIDDEN_ACTION = re.compile(r"(^Microsoft\.Authorization/|/delete$|listSecrets|^Microsoft\.KeyVault/|^\*)", re.I)
HAND_BUILT = re.compile(
    r"'(rg|cae|kv|cr|st|id|ca|caj|pgsql|sql|sqldb|appi|ag|budget|log|vnet|snet|nsg|ng|pip|pep|nic|afd|fde|waf|secp|"
    r"og|orig|route|cd|fd|lz|release|fic|alert|diag|link|peer|bvault|lock|sc)-?\$\{")

GUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
ROLE_OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635"
ROLE_USER_ACCESS_ADMINISTRATOR = "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9"
ROLE_RBAC_ADMINISTRATOR = "f58310d9-a9f6-439a-9e8d-f62e7b41a168"
ROLE_CONTRIBUTOR = "b24988ac-6180-42a0-ab88-20f7382dd24c"
ROLE_READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7"
# Microsoft Learn, "Examples to delegate Azure role assignment management with conditions":
# Constrain roles, and constrain roles and principals (ADR-0043). Per clause (write on @Request,
# delete on @Resource), the groups are: the unrestricted role set, the portal's two reader roles and
# the portal principal, Platform Job Secret Writer and the Entra provisioning principal.
def _rbac_clause(action: str, source: str) -> str:
    role = rf"@{source}\[Microsoft\.Authorization/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{{([^}}]*)\}}"
    principal = rf"@{source}\[Microsoft\.Authorization/roleAssignments:PrincipalId\] ForAnyOfAnyValues:GuidEquals \{{([^}}]*)\}}"
    return (rf"\(!\(ActionMatches\{{'Microsoft\.Authorization/roleAssignments/{action}'\}}\)\) OR \({role}\) OR "
            rf"\({role} AND {principal}\) OR \({role} AND {principal}\)")


RBAC_CONDITION = re.compile(r"\(" + _rbac_clause("write", "Request") + r"\) AND \(" + _rbac_clause("delete", "Resource") + r"\)")
# Compiled entry templates whose role assignments the provisioning identity performs.
ROLE_SCAN_TEMPLATES = ["environment.bicep", "roles.bicep", "bootstrap.bicep", "landing-zone.bicep", "release.bicep", "names.bicep",
                       "portal.bicep", "frontdoor.bicep", "portal-vault-endpoint.bicep"]
# Entra Deployment Operator (bootstrap.bicep, ADR-0033): exactly these actions.
ENTRA_ROLE_ACTIONS = ["Microsoft.Resources/deployments/*", "Microsoft.Resources/subscriptions/resourceGroups/read"]
# Custom roles of roles.bicep (Contoso example). The two delivery roles are in the provisioning
# identity's role set; Platform Job Secret Writer (ADR-0035) is not, and has exactly these actions.
ROLES_EXAMPLE = "platform/examples/contoso-roles.bicepparam"
DELIVERY_ROLE_NAMES = ["App Deployer (contoso)", "App Environment Joiner (contoso)"]
JOB_SECRET_WRITER_ROLE_NAME = "Platform Job Secret Writer (contoso)"
JOB_SECRET_WRITER_ACTIONS = [
    "Microsoft.App/jobs/read",
    "Microsoft.App/jobs/write",
    "Microsoft.App/jobs/start/action",
    "Microsoft.App/jobs/executions/read",
    "Microsoft.App/locations/containerappsjobOperationStatuses/read",
    "Microsoft.App/locations/containerappsjobOperationResults/read",
]
# environment example -> (environment name, {CAE mode abbreviation: environment vault variant letter})
# managed-network CAE -> public vault (p), VNet-based CAE -> private vault (n) (ADR-0028).
ENVIRONMENT_EXAMPLES = {
    "platform/examples/contoso-nonprod.bicepparam": ("nonprod", {"ext": "p", "hyb": "n"}),
    "platform/examples/contoso-prod.bicepparam": ("prod", {"ext": "n", "hyb": "n"}),
}
KVSET_ENV = ["SAF_VAULT_URI", "SAF_VAULT_AUDIENCE", "AZURE_CLIENT_ID"]
DBINIT_ENV = ["SAF_PG_AUDIENCE", "SAF_PG_HOST_SUFFIX", "SAF_SQL_HOST_SUFFIX", "SAF_DB_ADMIN", "AZURE_CLIENT_ID"]
ROLE_REPOSITORY_READER = "b93aa761-3e63-49ed-ac28-beffa264f7ac"
# Key Vault Secrets User (types.builtInRoles): portal.bicep gives it to the portal identity on the one
# SMTP password secret, once it exists (US10.18, ADR-0025 amendment 2026-11-14).
ROLE_KEY_VAULT_SECRETS_USER = "4633458b-17de-408a-b874-0445c86b69e6"
# Log Analytics Reader: environment.bicep assigns it on the workspace to the portal identity only
# (ADR-0026); outside the platform role set on purpose, like Platform Job Secret Writer.
ROLE_LOG_ANALYTICS_READER = "73c42c96-874c-492b-b04d-ab87d138a893"
# Cost Management Reader: environment.bicep assigns it at subscription scope to the portal identity
# only (ADR-0017, the Costs tab); outside the platform role set on purpose, like Log Analytics Reader.
ROLE_COST_MANAGEMENT_READER = "72fafb9e-0641-4937-9268-a91bfd8191a3"
# The portal identity's roles in environment.bicep: exactly these, nothing else.
PORTAL_ENVIRONMENT_ROLES = {ROLE_LOG_ANALYTICS_READER, ROLE_COST_MANAGEMENT_READER}
# Container Registry Repository Contributor (types.registryPurgeRole, ADR-0059): landing-zone.bicep gives it to
# its deployer, the provisioning identity, on a build environment's app registry; bootstrap.bicep lets that
# identity assign it to itself only. Outside the platform role set on purpose.
ROLE_REGISTRY_PURGE = "2efddaa5-3f1f-4df3-97df-af3f13818f4c"
# instancePrincipals of the nonprod bootstrap example (the limited roles' principals, ADR-0043).
EXAMPLE_PORTAL_PRINCIPAL = "00000000-0000-0000-0000-00000000e102"
EXAMPLE_ENTRA_PRINCIPAL = "00000000-0000-0000-0000-00000000d101"
# Reader (types.builtInRoles.reader): environment.bicep gives it to the portal identity on the
# managed Front Door profile only, for the apps' custom domains (ADR-0010, amended 2026-11-01).
ROLE_READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7"
# Microsoft Graph and the application permissions (app role IDs) of the Entra provisioning
# identity (infra/platform/entra-permissions.bicep, ADR-0023).
GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"
# Delegated Microsoft Graph permissions of the portal registration (ADR-0036, ADR-0040), IDs from
# the Graph permissions reference (https://learn.microsoft.com/en-us/graph/permissions-reference).
PORTAL_GRAPH_SCOPES = {
    "openid": "37f7f235-527c-4136-accd-4a02d197296e",
    "profile": "14dad69e-099b-42c9-810b-d002981feec1",
    "offline_access": "7427e0e9-2fba-42fe-b0c0-848c9e6a8182",
    "User.Read.All": "a154be20-db9c-4678-8ab7-66f6cc099a59",
    "GroupMember.Read.All": "bc024368-1153-4739-b217-4326f2e966d0",
}
# A managed identity as federated credential ("Configure an application to trust a managed
# identity", Microsoft Learn): issuer {login endpoint}{tenant}/v2.0, subject = principal ID.
# Azure Key Vault (first-party application) and its delegated scope user_impersonation (ADR-0025):
# the portal's OBO secret writes. The app ID is on Microsoft Learn (Az.KeyVault docs); the scope ID
# was read from the Key Vault service principal in the sandbox tenant (portal-registration.bicep).
KEY_VAULT_APP_ID = "cfa8b339-82a2-471a-a3c9-0fc0be7a4093"
KEY_VAULT_USER_IMPERSONATION = "f53da476-18e3-4152-8e01-aec403e6edc0"
TOKEN_EXCHANGE_AUDIENCE = "api://AzureADTokenExchange"
ENTRA_GRAPH_PERMISSIONS = {
    "18a4783c-866b-4cc7-a460-3d5e5662c884": "Application.ReadWrite.OwnedBy",
    "06b708a9-e830-4db3-a914-8e69da51d44f": "AppRoleAssignment.ReadWrite.All",
    "9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30": "Application.Read.All",
    "8e8e4742-1d95-4f68-9d56-6ee75648c72a": "DelegatedPermissionGrant.ReadWrite.All",
}
ENTRA_PERMISSIONS_EXAMPLE = "platform/examples/contoso-entra-permissions.bicepparam"
ENTRA_AUDIT_ALERT_EXAMPLE = "platform/examples/contoso-entra-audit-alert.bicepparam"
# Portal (portal.bicep, ADR-0036): example, pass-2 inputs (environment variables of the example)
# and the container env var contract shared with the portal image (portal/, W1).
PORTAL_EXAMPLE = "platform/examples/contoso-portal.bicepparam"
PORTAL_REGISTRATION_EXAMPLE = "entra/examples/contoso-portal-prod.bicepparam"
DEFAULT_APP_ROLE = "00000000-0000-0000-0000-000000000000"
PORTAL_DIGEST = "sha256:" + "0123456789abcdef" * 4
PORTAL_CLIENT_ID = "00000000-0000-0000-0000-00000000e101"
# The portal's own host name of the examples (ADR-0071): portal.contoso.com through afd-contoso-prod, the zone
# contoso.com in another subscription (records by hand), two stand-in AzureFrontDoor.Backend ranges.
PORTAL_FRONT_DOOR = {"hostName": "portal.contoso.com", "dnsZoneId": "", "backendIpRanges": ["192.0.2.0/24", "198.51.100.0/24"]}
PORTAL_ZONE_ID = f"/subscriptions/{{sub}}/resourceGroups/rg-dns/providers/Microsoft.Network/dnszones/contoso.com"
PORTAL_ENV = {
    "PORT": "8080",
    "SAF_TENANT_ID": TENANT,
    "SAF_PORTAL_CLIENT_ID": PORTAL_CLIENT_ID,
    "SAF_CONFIG_SOURCE": "ado",
    "SAF_ADO_ORGANIZATION_URL": "https://dev.azure.com/contoso",
    "SAF_ADO_PROJECT": "Platform",
    "SAF_ADO_REPOSITORY": "platform-config",
    "SAF_ADO_BRANCH": "main",
    "SAF_DATABASE_NAME": "portal",
}  # plus AZURE_CLIENT_ID (the portal identity's client ID), SAF_DATABASE_HOST (the server's FQDN) and
# SAF_SMTP_PASSWORD_VAULT_URI (the environment vault with the SMTP password, or empty: ADR-0025 amendment 2026-11-14)
# bootstrap example -> (instanceIdentities, federation set, environment name)
BOOTSTRAP_EXAMPLES = {
    "platform/examples/contoso-bootstrap-nonprod.bicepparam": (False, False, "nonprod"),
    "platform/examples/contoso-bootstrap-prod.bicepparam": (True, True, "prod"),
}

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def bicep_binary() -> str:
    for candidate in (shutil.which("bicep"), str(Path.home() / ".azure" / "bin" / "bicep")):
        if candidate and Path(candidate).is_file():
            return candidate
    sys.exit("check-infra: bicep CLI not found (run `az bicep install`).")


def run(args: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, env=env)


def diagnostics(output: str) -> list[str]:
    return [l for l in output.splitlines() if re.search(r"\) : (Error|Warning) ", l)]


def lint_all() -> None:
    files = sorted(INFRA.rglob("*.bicep"))
    for f in files:
        res = run(["az", "bicep", "lint", "--file", str(f)])
        diags = diagnostics(res.stdout + res.stderr)
        check(res.returncode == 0 and not diags, f"lint {f.relative_to(REPO)}:\n  " + "\n  ".join(diags))
    print(f"lint: {len(files)} files")


def count_functions(template: dict, path: str) -> None:
    n = sum(len(ns.get("members", {})) for ns in template.get("functions", []))
    check(n <= 64, f"{path}: {n} user-defined functions (ARM limit 64)")
    resources = template.get("resources", {})
    for r in (resources.values() if isinstance(resources, dict) else resources):
        if r.get("type") == "Microsoft.Resources/deployments" and "template" in r.get("properties", {}):
            count_functions(r["properties"]["template"], f"{path} > {str(r.get('name'))[:40]}")


def build_entries() -> dict[str, dict]:
    compiled = {}
    for f in ENTRY_TEMPLATES:
        res = run(["az", "bicep", "build", "--file", str(f), "--stdout"])
        if res.returncode != 0:
            failures.append(f"build {f.relative_to(REPO)} failed:\n{res.stderr}")
            continue
        compiled[f.name] = json.loads(res.stdout)
        count_functions(compiled[f.name], str(f.relative_to(REPO)))
    print(f"build: {len(compiled)} entry templates")
    return compiled


def snapshot(param_file: Path, extra: list[str], env: dict[str, str] | None = None) -> tuple[int, str, dict | None]:
    out = param_file.with_name(param_file.name.replace(".bicepparam", ".snapshot.json"))
    if out.exists():
        out.unlink()
    # Parameter files read pipeline-injected values (SAF_*) from the environment: never from the
    # caller's shell, only from an explicit env.
    env = env if env is not None else with_env("", None)
    res = run([bicep_binary(), "snapshot", str(param_file), "--tenant-id", TENANT, "--location", "westeurope", *extra], env)
    data = json.loads(out.read_text()) if res.returncode == 0 and out.exists() else None
    if out.exists():
        out.unlink()
    return res.returncode, res.stdout + res.stderr, data


def snapshots() -> dict[str, dict]:
    snaps = {}
    for rel, extra in EXAMPLES.items():
        rc, log, data = snapshot(INFRA / rel, extra)
        check(rc == 0 and data is not None and not data.get("diagnostics"),
              f"snapshot {rel} failed:\n{log[:1500]}")
        if data is not None:
            snaps[rel] = data
        # Per-app registrations only; the portal registration has its own check (check_portal_registration).
        if data is not None and rel.startswith("entra/") and rel != PORTAL_REGISTRATION_EXAMPLE:
            check_entra_assignments(rel, data)
    print(f"snapshot: {len(EXAMPLES)} examples")

    with tempfile.TemporaryDirectory(prefix="saf-infra-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
        for label, rel, replacements, fragment in NEGATIVE:
            src = (work / rel).read_text()
            text = src
            for old, new in replacements:
                check(old in text, f"negative '{label}': marker '{old[:40]}' not found in {rel}")
                text = text.replace(old, new, 1)
            case = (work / rel).with_name("negative-case.bicepparam")
            case.write_text(text)
            rc, log, _ = snapshot(case, EXAMPLES[rel])
            check(rc != 0 and fragment.lower() in log.lower(),
                  f"negative '{label}' did not fail with '{fragment}':\n{log[:600]}")
            case.unlink()
    print(f"negative: {len(NEGATIVE)} cases")
    return snaps


DELIVERY = INFRA / "app" / "delivery"
DELIVERY_FIXTURE = DELIVERY / "examples" / "hotel-inventory-nonprod.release.json"
DELIVERY_ARGS = ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-app-hotel-inventory-nonprod"]

# (label, change to the fixture, expected message fragment)
DELIVERY_NEGATIVE = [
    ("digest format", lambda r: r["image"].update(digest="latest"), "image.digest must be"),
    ("reserved env var", lambda r: r["env"][0].update(name="DATABASE_HOST"), "platform-reserved names: DATABASE_HOST"),
    ("port is an int", lambda r: r["runtime"].update(port="8080"), 'expected a value of type "int"'),
    ("unknown network mode", lambda r: r.update(networkMode="internalOnly"), "'externalHybrid' | 'externalOnly'"),
    ("Easy Auth needs a client id", lambda r: r["authentication"].update(clientId=None), "authentication.clientId is required"),
    ("run id is a number", lambda r: r["run"].update(id="12a4"), "run.id must be a pipeline run number"),
    ("run commit is a full SHA", lambda r: r["run"].update(commit="abc123"), "run.commit must be a full commit SHA"),
    # The tag saf-core (ADR-0049): the core version is required, no default (hard rule 6).
    ("core version is required", lambda r: r.pop("coreVersion"), "coreVersion"),
    # The capacity cell (ADR-0053, ADR-0060 amendment 2026-11-16): required, no default; release-params writes it.
    ("cell is required", lambda r: r.pop("cell"), "cell"),
    ("cell 00 is no cell", lambda r: r.update(cell="00"), "invalid cell id"),
]


PROVISIONING = INFRA / "app" / "provisioning"
ENTRA_PROVISIONING = INFRA / "entra" / "provisioning"
PLATFORM_PIPELINE = INFRA / "platform" / "pipeline"
INSTANCE_PARAMS = INFRA / "platform" / "instance"
RG_NONPROD = ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-app-hotel-inventory-nonprod"]

# The onboarding parameter files (ADR-0066): (label, parameter file, example input, the hand-written
# example whose resources it must predict, snapshot arguments).
INSTANCE_CASES = [
    ("instance bootstrap prod", "bootstrap.bicepparam", "contoso-prod.bootstrap.json",
     "platform/examples/contoso-bootstrap-prod.bicepparam", ["--subscription-id", PROD_SUB]),
    ("instance bootstrap nonprod", "bootstrap.bicepparam", "contoso-nonprod.bootstrap.json",
     "platform/examples/contoso-bootstrap-nonprod.bicepparam", ["--subscription-id", NONPROD_SUB]),
    ("instance roles", "roles.bicepparam", "contoso.roles.json", "platform/examples/contoso-roles.bicepparam",
     ["--subscription-id", PROD_SUB]),
    ("instance Graph permissions", "entra-permissions.bicepparam", "contoso.entra-permissions.json",
     "platform/examples/contoso-entra-permissions.bicepparam", ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-entra"]),
    ("instance portal registration", "portal-registration.bicepparam", "contoso-prod.portal-registration.json",
     "entra/examples/contoso-portal-prod.bicepparam", ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-entra"]),
    ("instance audit alert", "entra-audit-alert.bicepparam", "contoso.entra-audit-alert.json",
     "platform/examples/contoso-entra-audit-alert.bicepparam", ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-platform-prod"]),
]
INSTANCE_FEDERATION = {"issuer": f"https://login.microsoftonline.com/{TENANT}/v2.0", "subject": "/eid1/c/pub/t/x/a/y/sc/z/w"}

# (label, parameter file, env var, fixture, snapshot args)
PROVISIONING_CASES = [
    ("lz nonprod", PROVISIONING / "landing-zone.bicepparam", "SAF_LZ_JSON",
     PROVISIONING / "examples" / "hotel-inventory-nonprod.lz.json", ["--subscription-id", NONPROD_SUB]),
    ("lz prod", PROVISIONING / "landing-zone.bicepparam", "SAF_LZ_JSON",
     PROVISIONING / "examples" / "hotel-inventory-prod.lz.json", ["--subscription-id", PROD_SUB]),
    ("release nonprod (bootstrap)", PROVISIONING / "release.bicepparam", "SAF_RELEASE_JSON",
     PROVISIONING / "examples" / "hotel-inventory-nonprod.release.json", RG_NONPROD),
    ("entra nonprod", ENTRA_PROVISIONING / "app-registration.bicepparam", "SAF_ENTRA_JSON",
     ENTRA_PROVISIONING / "examples" / "hotel-inventory-nonprod.entra.json", RG_NONPROD),
    # The platform pipeline (ADR-0043): `platform environment inputs` of config/examples/instance.example.yaml.
    ("platform environment nonprod", PLATFORM_PIPELINE / "environment.bicepparam", "SAF_ENVIRONMENT_JSON",
     PLATFORM_PIPELINE / "examples" / "contoso-nonprod.environment.json", ["--subscription-id", NONPROD_SUB]),
    ("platform environment prod", PLATFORM_PIPELINE / "environment.bicepparam", "SAF_ENVIRONMENT_JSON",
     PLATFORM_PIPELINE / "examples" / "contoso-prod.environment.json", ["--subscription-id", PROD_SUB]),
    # The portal through the host's platform pipeline (ADR-0043 decision 10): `platform environment
    # portal-inputs --pass auto` of instance.example.yaml (pass 2: portal.clientId is set).
    ("platform portal prod", PLATFORM_PIPELINE / "portal.bicepparam", "SAF_PORTAL_JSON",
     PLATFORM_PIPELINE / "examples" / "contoso-prod.portal.json", ["--subscription-id", PROD_SUB]),
    # The app's custom domain through Front Door (ADR-0010, amended 2026-11-01): deployment
    # fd-{slug}-{env} in the environment's platform resource group.
    ("frontdoor nonprod", PROVISIONING / "frontdoor.bicepparam", "SAF_FRONTDOOR_JSON",
     PROVISIONING / "examples" / "hotel-inventory-nonprod.frontdoor.json",
     ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-platform-nonprod", "--deployment-name", "fd-hotel-inventory-nonprod"]),
    ("portal endpoint prod", PROVISIONING / "portal-endpoint.bicepparam", "SAF_PORTAL_ENDPOINT_JSON",
     PROVISIONING / "examples" / "hotel-inventory-prod.portal-endpoint.json",
     ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-portal-prod", "--deployment-name", "pep-portal-hotel-inventory-prod"]),
    # Onboarding an instance (ADR-0066): `platform instance inputs` of instance.example.yaml and the
    # state fixtures of tools/platform-cli/test/fixtures/instance (check_instance_onboarding).
    *[(label, INSTANCE_PARAMS / param, "SAF_INSTANCE_JSON", INSTANCE_PARAMS / "examples" / fixture, args)
      for label, param, fixture, _, args in INSTANCE_CASES],
]

# (label, case label, change to the fixture, expected message fragment)
PROVISIONING_NEGATIVE = [
    ("lz generation is an int", "lz nonprod", lambda d: d.update(generation="0"), 'expected a value of type "int"'),
    ("lz network mode", "lz nonprod", lambda d: d.update(networkMode="internalOnly"), "'externalHybrid' | 'externalOnly'"),
    ("lz owner needs an email", "lz nonprod", lambda d: d["owner"].pop("email"), "email"),
    ("lz owner and deputy differ", "lz nonprod", lambda d: d["deputy"].update(principalId=d["owner"]["principalId"]),
     "owner and deputy must be different principals"),
    ("lz budget amount is an int", "lz nonprod", lambda d: d["budget"].update(amount="50"), 'expected a value of type "int"'),
    ("lz retention at least 7 (PostgreSQL)", "lz nonprod", lambda d: d.update(backupRetentionDays=6), "minimum allowable value is 7"),
    ("lz portal principal is a GUID", "lz nonprod", lambda d: d.update(portalIdentityPrincipalId="id-contoso-portal"),
     "portalIdentityPrincipalId must be empty or a GUID"),
    # ADR-0060: modeChange is always in the input (null in the steady state); a prepare pass needs another mode.
    ("lz modeChange is required", "lz nonprod", lambda d: d.pop("modeChange"), "modeChange"),
    ("lz modeChange from the same mode", "lz nonprod", lambda d: d.update(modeChange={"phase": "prepare", "fromNetworkMode": "externalOnly"}),
     "modeChange.fromNetworkMode must differ from networkMode"),
    ("lz modeChange from internalOnly", "lz prod", lambda d: d.update(modeChange={"phase": "prepare", "fromNetworkMode": "internalOnly"}),
     "'externalHybrid' | 'externalOnly'"),
    ("release port is an int", "release nonprod (bootstrap)", lambda d: d["runtime"].update(port="8080"), 'expected a value of type "int"'),
    ("release reserved env var", "release nonprod (bootstrap)",
     lambda d: d.update(env=[{"name": "DATABASE_HOST", "value": "x"}]), "platform-reserved names: DATABASE_HOST"),
    ("release Easy Auth needs a client id", "release nonprod (bootstrap)",
     lambda d: d["authentication"].update(clientId=None), "authentication.clientId is required"),
    ("entra wildcard host", "entra nonprod", lambda d: d.update(hosts=["*.contoso.com"]), "hosts must be plain host names"),
    ("frontdoor host is a lower-case host name", "frontdoor nonprod", lambda d: d.update(hostName="Hotel-inventory-test.contoso.com"),
     "must be a lowercase host name"),
    ("frontdoor network mode", "frontdoor nonprod", lambda d: d.update(networkMode="internalOnly"), "'externalHybrid' | 'externalOnly'"),
    # The capacity cell (ADR-0053, ADR-0060 amendment 2026-11-16): required in each template's input, two digits, 01 to 99.
    ("lz cell is required", "lz nonprod", lambda d: d.pop("cell"), "cell"),
    ("lz cell 00 is no cell", "lz nonprod", lambda d: d.update(cell="00"), "invalid cell id"),
    ("release cell is required", "release nonprod (bootstrap)", lambda d: d.pop("cell"), "cell"),
    ("frontdoor cell is required", "frontdoor nonprod", lambda d: d.pop("cell"), "cell"),
    ("entra unknown role", "entra nonprod", lambda d: d["roleAssignments"][0].update(role="Owner"), "references a role that is not in appRoles"),
    # ADR-0061: the incarnation is always in the input (app-level, no default) and never negative.
    ("entra incarnation is required", "entra nonprod", lambda d: d.pop("incarnation"), "incarnation"),
    ("entra incarnation at least 0", "entra nonprod", lambda d: d.update(incarnation=-1), "minimum allowable value is 0"),
    ("platform digest format", "platform environment nonprod", lambda d: d.update(platformJobsImageDigest="latest"),
     "platformJobsImageDigest must be empty (pass 1) or sha256"),
    ("platform internalOnly", "platform environment nonprod", lambda d: d["networkModes"].update(internalOnly={}), "internalOnly is not available"),
    ("platform Entra principal is a GUID", "platform environment nonprod", lambda d: d.update(entraProvisioningPrincipalId="id-contoso-entra-provisioning"),
     "entraProvisioningPrincipalId must be a GUID"),
    ("platform retention is an int", "platform environment nonprod", lambda d: d.update(logRetentionDays="30"), 'expected a value of type "int"'),
    ("platform portal digest format", "platform portal prod", lambda d: d.update(portalImageDigest="latest"),
     "portalImageDigest must be empty (pass 1) or sha256"),
    ("platform portal pass 2 needs the client ID", "platform portal prod", lambda d: d.update(portalClientId=""),
     "portalClientId must be the client ID (a GUID) of the portal's Entra app registration when portalImageDigest is set"),
    ("platform portal hub route table", "platform portal prod",
     lambda d: d["network"].update(routeTableId=f"/subscriptions/{PROD_SUB}/resourceGroups/rg-network/providers/Microsoft.Network/routeTables/rt-hub"),
     "routeTableId is not available in this core version"),
    ("platform portal tenant is the deployment's", "platform portal prod", lambda d: d.update(tenantId="00000000-0000-0000-0000-0000000000ff"),
     "is not the tenant of this deployment"),
    ("platform portal retention is an int", "platform portal prod", lambda d: d["database"].update(backupRetentionDays="35"),
     'expected a value of type "int"'),
    ("platform portal database is required", "platform portal prod", lambda d: d.pop("database"), "database"),
    ("portal endpoint generation is an int", "portal endpoint prod", lambda d: d.update(generation="0"), 'expected a value of type "int"'),
    ("portal endpoint for a managed-network vault", "portal endpoint prod", lambda d: d.update(networkMode="externalOnly"),
     "runs on the Azure-managed network in prod"),
    ("portal endpoint of another portal environment", "portal endpoint prod", lambda d: d.update(portalEnvironmentName="nonprod"),
     "deploy into the portal resource group rg-contoso-portal-nonprod"),
    ("portal endpoint subscription is a GUID", "portal endpoint prod", lambda d: d.update(vaultSubscriptionId="prod"),
     "vaultSubscriptionId must be a subscription ID"),
    # Onboarding (ADR-0066): the bootstrap's guards hold through the instance input too.
    ("instance bootstrap: ADO federation outside the host", "instance bootstrap nonprod",
     lambda d: d["federation"].update(adoAutomation=INSTANCE_FEDERATION), "federation.adoAutomation needs instanceIdentities = true"),
    ("instance bootstrap: the host takes no instancePrincipals", "instance bootstrap prod",
     lambda d: d.update(instancePrincipals={"portal": "00000000-0000-0000-0000-00000000e102", "entraProvisioning": "00000000-0000-0000-0000-00000000d101"}),
     "instancePrincipals must be {} in the portal host subscription"),
    ("instance bootstrap: outside the host it needs instancePrincipals", "instance bootstrap nonprod",
     lambda d: d.update(instancePrincipals={}), "instancePrincipals needs portal and entraProvisioning as GUIDs"),
    ("instance bootstrap: Entra groups outside the host", "instance bootstrap nonprod",
     lambda d: d.update(entraEnvironments=["nonprod"]), "entraEnvironments must be [] outside the portal host subscription"),
    ("instance bootstrap: instanceIdentities is a bool", "instance bootstrap prod",
     lambda d: d.update(instanceIdentities="true"), 'expected a value of type "bool"'),
    ("instance roles: subscriptions are a list", "instance roles",
     lambda d: d.update(environmentSubscriptionIds=PROD_SUB), 'expected a value of type "string[]"'),
    ("instance registration: host name without scheme", "instance portal registration",
     lambda d: d.update(portalHostName="https://" + d["portalHostName"]), "portalHostName must be a plain lowercase host name"),
    ("instance audit alert: the workspace", "instance audit alert",
     lambda d: d.update(workspaceResourceId=f"/subscriptions/{PROD_SUB}/resourceGroups/rg-contoso-platform-prod"),
     "workspaceResourceId must be the resource ID of a Log Analytics workspace"),
]


def predicted(data: dict | None) -> list:
    return sorted(json.dumps(r, sort_keys=True) for r in (data or {}).get("predictedResources", []))


def provisioning_params() -> None:
    """infra/app/provisioning/*.bicepparam and infra/entra/provisioning/*.bicepparam."""
    cases = {}
    for label, param_file, var, fixture_path, args in PROVISIONING_CASES:
        fixture = json.loads(fixture_path.read_text())
        cases[label] = (param_file, var, fixture, args)
        rc, log, data = snapshot(param_file, args, with_env(var, json.dumps(fixture)))
        check(rc == 0 and data is not None and not data.get("diagnostics"), f"provisioning {label} snapshot failed:\n{log[:1500]}")
        if data is not None and label.startswith("entra"):
            check_entra_assignments(f"provisioning {label}", data)
            check_entra_unique_name(f"provisioning {label}", param_file, var, fixture, args, data)
        # Keys the template doesn't read change nothing (an input can't add parameters).
        extra = copy.deepcopy(fixture)
        extra.update(subscriptionId=PROD_SUB, tenantId=TENANT, deployedBy="delivery", alertsEnabled=False, vnetBased=False)
        rc2, log2, data2 = snapshot(param_file, args, with_env(var, json.dumps(extra)))
        if label.startswith("release"):
            # deployedBy is a literal: smuggling 'delivery' keeps provisioning mode (Easy Auth config).
            types = {r.get("type") for r in (data2 or {}).get("predictedResources", [])}
            check(rc2 == 0 and "Microsoft.App/containerApps/authConfigs" in types,
                  f"provisioning {label}: deployedBy from the input must not switch to delivery mode, got {sorted(types)}:\n{log2[:600]}")
        else:
            check(rc2 == 0 and predicted(data2) == predicted(data),
                  f"provisioning {label}: extra input keys changed the deployment:\n{log2[:600]}")
        rc3, log3, _ = snapshot(param_file, args, with_env(var, None))
        check(rc3 != 0 and var in log3, f"provisioning {label} without {var} did not fail:\n{log3[:600]}")
        if label.startswith("portal endpoint") and data is not None:
            rc4, log4, example = snapshot(INFRA / PVE_EXAMPLE, EXAMPLES[PVE_EXAMPLE])
            check(rc4 == 0 and example is not None and predicted(example) == predicted(data)
                  and example.get("outputs") == data.get("outputs"),
                  f"provisioning {label}: the parameter file and {PVE_EXAMPLE} give different deployments:\n{log4[:600]}")

    for label, case_label, change, fragment in PROVISIONING_NEGATIVE:
        param_file, var, fixture, args = cases[case_label]
        case = copy.deepcopy(fixture)
        change(case)
        rc, log, _ = snapshot(param_file, args, with_env(var, json.dumps(case)))
        check(rc != 0 and fragment.lower() in log.lower(), f"provisioning negative '{label}' did not fail with '{fragment}':\n{log[:600]}")
    print(f"provisioning: {len(PROVISIONING_CASES)} inputs (+ extra keys, missing input), {len(PROVISIONING_NEGATIVE)} negative")


def check_platform_pipeline(snaps: dict[str, dict]) -> None:
    """infra/platform/pipeline/ (ADR-0043): the platform pipeline deploys environment.bicep only
    through environment.bicepparam and takes its names from platform-names.bicep."""
    param = PLATFORM_PIPELINE / "environment.bicepparam"
    nonprod = json.loads((PLATFORM_PIPELINE / "examples" / "contoso-nonprod.environment.json").read_text())
    rc, log, data = snapshot(param, ["--subscription-id", NONPROD_SUB], with_env("SAF_ENVIRONMENT_JSON", json.dumps(nonprod)))
    check(rc == 0 and data is not None, f"platform pipeline nonprod snapshot failed:\n{log[:1500]}")
    example = snaps.get("platform/examples/contoso-nonprod.bicepparam")
    check(data is not None and example is not None and predicted(data) == predicted(example),
          "platform pipeline: the nonprod input (`platform environment inputs` of instance.example.yaml) must predict exactly "
          "the resources of platform/examples/contoso-nonprod.bicepparam")
    # Pass 1 (a new environment): the registry and everything else, no platform job, no job role.
    pass1 = dict(nonprod, platformJobsImageDigest="")
    rc, log, data = snapshot(param, ["--subscription-id", NONPROD_SUB], with_env("SAF_ENVIRONMENT_JSON", json.dumps(pass1)))
    types = [r.get("type") for r in (data or {}).get("predictedResources", [])]
    check(rc == 0 and "Microsoft.ContainerRegistry/registries" in types and "Microsoft.App/jobs" not in types,
          f"platform pipeline pass 1 must create the registry and no job, got {sorted(set(map(str, types)))}:\n{log[:600]}")
    # platform-names.bicep: what the scripts read.
    names_param = PLATFORM_PIPELINE / "platform-names.bicepparam"
    names_input = {"prefix": "contoso", "environmentName": "nonprod", "modes": ["externalOnly", "externalHybrid"], "vaultGeneration": 0}
    rc, log, names = snapshot(names_param, ["--subscription-id", NONPROD_SUB], with_env("SAF_PLATFORM_NAMES_JSON", json.dumps(names_input)))
    out = (names or {}).get("outputs", {})
    # The environment vaults (the portal host's plan reads the SMTP secret in one of them): as environment.bicep names them.
    example_vaults = sorted(str(r.get("name")) for r in (example or {}).get("predictedResources", []) if r.get("type") == "Microsoft.KeyVault/vaults")
    check(sorted([str(out.get("environmentVaultPublic")), str(out.get("environmentVaultPrivate"))]) == example_vaults
          and str(out.get("environmentVaultPublic")).startswith("kvcontosononprodp"),
          f"platform names.bicep environment vaults {out.get('environmentVaultPublic')}, {out.get('environmentVaultPrivate')} differ from the nonprod example's {example_vaults}")
    rc_g, _, names_g = snapshot(names_param, ["--subscription-id", NONPROD_SUB], with_env("SAF_PLATFORM_NAMES_JSON", json.dumps(dict(names_input, vaultGeneration=1))))
    check(rc_g == 0 and (names_g or {}).get("outputs", {}).get("environmentVaultPrivate") not in (None, out.get("environmentVaultPrivate")),
          "platform names.bicep: another vaultGeneration must name other environment vaults")
    check(rc == 0 and out.get("platformDeployment") == "platform-contoso-nonprod"
          and out.get("platformResourceGroup") == "rg-contoso-platform-nonprod"
          and out.get("jobs") == [{"mode": "externalOnly", "kvset": "caj-contoso-kvset-ext", "dbinit": "caj-contoso-dbinit-ext"},
                                  {"mode": "externalHybrid", "kvset": "caj-contoso-kvset-hyb", "dbinit": "caj-contoso-dbinit-hyb"}],
          f"platform names.bicep outputs: {out}\n{log[:600]}")
    registry = next((r.get("name") for r in (example or {}).get("predictedResources", []) if r.get("type") == "Microsoft.ContainerRegistry/registries"), None)
    check(out.get("platformRegistry") == registry, f"platform names.bicep registry {out.get('platformRegistry')} is not the example's {registry}")
    roles = {r.get("roleName"): str(r.get("id")).lower() for r in out.get("customRoles", [])}
    defined = {name: str(d.get("name", "")).lower() for name, d in custom_role_definitions(snaps).items()}
    check(roles == defined, f"platform names.bicep custom roles {roles} differ from the roles example {defined}")
    rc, log, _ = snapshot(names_param, ["--subscription-id", NONPROD_SUB], with_env("SAF_PLATFORM_NAMES_JSON", json.dumps(dict(names_input, modes=["internalOnly"]))))
    check(rc != 0, f"platform names.bicep must refuse internalOnly:\n{log[:400]}")
    # The portal's names (read only by the host's pipeline): the record, its resource group and app.
    check(out.get("portalDeployment") == "portal-contoso-nonprod" and out.get("portalResourceGroup") == "rg-contoso-portal-nonprod"
          and out.get("portalContainerApp") == "ca-contoso-portal",
          f"platform names.bicep portal outputs: {[out.get(k) for k in ('portalDeployment', 'portalResourceGroup', 'portalContainerApp')]}")
    check(out.get("frontDoorProfile") == "afd-contoso-nonprod", f"platform names.bicep frontDoorProfile {out.get('frontDoorProfile')} (ADR-0071)")
    # ADR-0070 decision 6: what portal.bicep created for its PostgreSQL database before, which the deploy removes.
    former = {k: out.get(k) for k in ("portalFormerPostgresServer", "portalFormerPostgresEndpoint", "portalFormerPostgresZone",
                                      "portalFormerPostgresZoneLink")}
    server = str(former["portalFormerPostgresServer"])
    check(re.fullmatch(r"pgsql-contoso-portal-nonprod-[a-z0-9]{6}", server) is not None
          and former["portalFormerPostgresEndpoint"] == f"pep-{server}"
          and former["portalFormerPostgresZone"] == "privatelink.postgres.database.azure.com"
          and former["portalFormerPostgresZoneLink"] == "link-vnet-contoso-portal-nonprod",
          f"platform names.bicep former portal database outputs: {former}")
    check_platform_pipeline_portal(snaps)
    print("platform pipeline: nonprod input equals the example, pass 1 without jobs, names and custom roles; "
          "the portal input equals the portal example in both passes")


PROD_SUB_PROFILE = f"/subscriptions/{PROD_SUB}/resourceGroups/rg-contoso-platform-prod/providers/Microsoft.Cdn/profiles/afd-contoso-prod"


def check_portal_front_door(label: str, resources: list[dict], host: str, zone_id: str) -> None:
    """The portal's own host name (ADR-0071): the apps' Front Door objects with the portal's names in the host's
    profile, serving only the custom domain; with an Azure DNS zone its CNAME and _dnsauth TXT marked saf-app=portal."""
    def one(t: str) -> dict:
        found = [r for r in resources if r.get("type") == t]
        check(len(found) == 1, f"{label}: {len(found)} resources of type {t}, expected 1")
        return found[0] if found else {}
    cd_name = "cd-" + host.replace(".", "-")
    og, origin, cd, route = (one("Microsoft.Cdn/profiles/originGroups"), one("Microsoft.Cdn/profiles/originGroups/origins"),
                             one("Microsoft.Cdn/profiles/customDomains"), one("Microsoft.Cdn/profiles/afdEndpoints/routes"))
    check(og.get("id") == f"{PROD_SUB_PROFILE}/originGroups/og-portal-prod"
          and origin.get("id") == f"{PROD_SUB_PROFILE}/originGroups/og-portal-prod/origins/orig-portal-prod"
          and cd.get("id") == f"{PROD_SUB_PROFILE}/customDomains/{cd_name}"
          and route.get("id") == f"{PROD_SUB_PROFILE}/afdEndpoints/fde-contoso-prod/routes/route-portal-prod",
          f"{label}: Front Door objects {[r.get('id') for r in (og, origin, cd, route)]}, expected the portal's in afd-contoso-prod")
    oprops = origin.get("properties", {})
    check("'ca-contoso-portal'" in str(oprops.get("hostName")) and oprops.get("hostName") == oprops.get("originHostHeader")
          and oprops.get("enforceCertificateNameCheck") is True and oprops.get("httpsPort") == 443,
          f"{label}: portal origin {oprops}, expected the Container App's own address as host and host header")
    cprops = cd.get("properties", {})
    check(cprops.get("hostName") == host and cprops.get("tlsSettings") == {"certificateType": "ManagedCertificate", "minimumTlsVersion": "TLS12"},
          f"{label}: portal custom domain {cprops}")
    rprops = route.get("properties", {})
    check(rprops.get("linkToDefaultDomain") == "Disabled" and rprops.get("httpsRedirect") == "Enabled"
          and rprops.get("forwardingProtocol") == "HttpsOnly" and rprops.get("patternsToMatch") == ["/*"]
          and [d.get("id") for d in rprops.get("customDomains", [])] == [f"{PROD_SUB_PROFILE}/customDomains/{cd_name}"]
          and "cacheConfiguration" not in rprops,
          f"{label}: portal route {rprops}, expected only its custom domain, HTTPS, no caching")
    records = [r for r in resources if r.get("type", "").startswith("Microsoft.Network/dnsZones/")]
    if zone_id:
        sub_name = host.removesuffix(".contoso.com")
        got = sorted((r["type"].rsplit("/", 1)[1], r["id"].rsplit("/", 1)[1], (r.get("properties") or {}).get("metadata")) for r in records)
        want = sorted([("CNAME", sub_name, {"saf-app": "portal", "saf-env": "prod"}),
                       ("TXT", f"_dnsauth.{sub_name}", {"saf-app": "portal", "saf-env": "prod"})])
        check(got == want, f"{label}: portal DNS records {got}, expected {want}")
    else:
        check(not records, f"{label}: no DNS records without a zone: {[r['id'] for r in records]}")


def check_platform_pipeline_portal(snaps: dict[str, dict]) -> None:
    """infra/platform/pipeline/portal.bicepparam (ADR-0043 decision 10): the pipeline's portal input
    (`platform environment portal-inputs` of instance.example.yaml) predicts exactly the resources of
    the hand-written portal example, pass 2 (digest and client ID) and pass 1 (both empty)."""
    param = PLATFORM_PIPELINE / "portal.bicepparam"
    pass2 = json.loads((PLATFORM_PIPELINE / "examples" / "contoso-prod.portal.json").read_text())
    check(pass2.get("portalImageDigest") == PORTAL_DIGEST and pass2.get("portalClientId") == PORTAL_CLIENT_ID,
          "platform pipeline portal: the example input must carry PORTAL_DIGEST and PORTAL_CLIENT_ID (pass 2)")
    args = ["--subscription-id", PROD_SUB]
    env2 = with_env("SAF_PORTAL_IMAGE_DIGEST", PORTAL_DIGEST)
    env2["SAF_PORTAL_CLIENT_ID"] = PORTAL_CLIENT_ID
    rc, log, example2 = snapshot(INFRA / PORTAL_EXAMPLE, EXAMPLES[PORTAL_EXAMPLE], env2)
    check(rc == 0 and example2 is not None, f"platform pipeline portal: the example's pass 2 failed:\n{log[:600]}")
    for label, data_in, example in (("pass 2", pass2, example2),
                                    ("pass 1", dict(pass2, portalImageDigest="", portalClientId=""), snaps.get(PORTAL_EXAMPLE))):
        rc, log, data = snapshot(param, args, with_env("SAF_PORTAL_JSON", json.dumps(data_in)))
        check(rc == 0 and data is not None and not (data or {}).get("diagnostics"), f"platform pipeline portal {label} snapshot failed:\n{log[:1500]}")
        check(data is not None and example is not None and predicted(data) == predicted(example),
              f"platform pipeline portal {label}: the input (`platform environment portal-inputs` of instance.example.yaml) must "
              f"predict exactly the resources of {PORTAL_EXAMPLE}")
        apps = [r for r in (data or {}).get("predictedResources", []) if r.get("type") == "Microsoft.App/containerApps"]
        check(len(apps) == (1 if label == "pass 2" else 0), f"platform pipeline portal {label}: {len(apps)} Container Apps")


def without_tags(value):
    """A predicted resource without its tags (at every level: module deployments pass them on)."""
    if isinstance(value, dict):
        return {k: without_tags(v) for k, v in value.items() if k != "tags"}
    if isinstance(value, list):
        return [without_tags(v) for v in value]
    return value


def check_instance_onboarding(snaps: dict[str, dict]) -> None:
    """infra/platform/instance/ (ADR-0066): each onboarding parameter file with the input `platform instance
    inputs` writes for instance.example.yaml predicts exactly the resources of the hand-written example of
    its template (the examples' tags aside: the CLI writes {} and ManagedBy from productName)."""
    for label, param, fixture, example, args in INSTANCE_CASES:
        data_in = json.loads((INSTANCE_PARAMS / "examples" / fixture).read_text())
        rc, log, data = snapshot(INSTANCE_PARAMS / param, args, with_env("SAF_INSTANCE_JSON", json.dumps(data_in)))
        hand = snaps.get(example)
        mine = sorted(json.dumps(without_tags(r), sort_keys=True) for r in (data or {}).get("predictedResources", []))
        theirs = sorted(json.dumps(without_tags(r), sort_keys=True) for r in (hand or {}).get("predictedResources", []))
        check(rc == 0 and data is not None and hand is not None and mine and mine == theirs,
              f"{label}: infra/platform/instance/{param} with examples/{fixture} must predict exactly the resources of {example}:\n{log[:600]}")
    print(f"instance onboarding: {len(INSTANCE_CASES)} inputs predict their hand-written examples")


# The ingress lock-down (ADR-0010, amended 2026-11-11; FD-3): the sandbox counted 157 IPv4 prefixes
# in AzureFrontDoor.Backend and a Container App accepted 157 Allow rules. Synthetic ranges, same count.
LOCKDOWN_RANGES = [f"198.{18 + i // 256}.{i % 256}.0/29" for i in range(157)]
ARM_TEMPLATE_MAX_BYTES = 4 * 1024 * 1024  # ARM: a template (and a request) may be at most 4 MB


def check_front_door_lockdown(compiled: dict[str, dict]) -> None:
    """release.bicep behind the managed Front Door with 157 backend ranges, through both parameter
    files (provisioning writes them, delivery copies them from the record): one Allow rule
    afd-backend-{n} per range in input order, FRONT_DOOR_ID, the 64-function and size limits; `none`
    ignores ranges."""
    template = compiled.get("release.bicep")
    check(template is not None, "lock-down: release.bicep did not compile")
    if template is not None:
        size = len(json.dumps(template, separators=(",", ":")).encode())
        check(size < ARM_TEMPLATE_MAX_BYTES, f"lock-down: compiled release.bicep is {size} bytes (ARM limit 4 MB)")
    front_door = {"mode": "managed", "frontDoorId": "00000000-0000-0000-0000-0000000000f1",
                  "hostNames": ["hotel-inventory-test.contoso.com"], "backendIpRanges": LOCKDOWN_RANGES}
    prov = json.loads((PROVISIONING / "examples" / "hotel-inventory-nonprod.release.json").read_text())
    deliv = json.loads(DELIVERY_FIXTURE.read_text())
    cases = [
        ("provisioning", PROVISIONING / "release.bicepparam", RG_NONPROD, prov),
        ("delivery", DELIVERY / "release.bicepparam", DELIVERY_ARGS, deliv),
    ]
    for label, param_file, args, fixture in cases:
        data_in = copy.deepcopy(fixture)
        data_in["frontDoor"] = copy.deepcopy(front_door)
        data_in["customDomains"] = []  # behind Front Door: no ACA-bound domain (release.bicep refuses both)
        body = json.dumps(data_in)
        check(len(body.encode()) < 64 * 1024, f"lock-down {label}: the release inputs are {len(body)} bytes")
        rc, log, data = snapshot(param_file, args, with_env("SAF_RELEASE_JSON", body))
        check(rc == 0 and data is not None and not data.get("diagnostics"), f"lock-down {label} snapshot failed:\n{log[:1500]}")
        apps = [r for r in (data or {}).get("predictedResources", []) if r.get("type") == "Microsoft.App/containerApps"]
        check(len(apps) == 1, f"lock-down {label}: expected one Container App, got {len(apps)}")
        if not apps:
            continue
        props = apps[0].get("properties", {})
        rules = props.get("configuration", {}).get("ingress", {}).get("ipSecurityRestrictions")
        want = [{"name": f"afd-backend-{i}", "description": "AzureFrontDoor.Backend", "ipAddressRange": r, "action": "Allow"}
                for i, r in enumerate(LOCKDOWN_RANGES)]
        check(rules == want, f"lock-down {label}: ipSecurityRestrictions are not one Allow rule afd-backend-{{n}} per range "
                             f"(got {len(rules or [])} rules, first {(rules or [None])[0]})")
        env = {e.get("name"): e.get("value") for c in props.get("template", {}).get("containers", []) for e in c.get("env", [])}
        check(env.get("FRONT_DOOR_ID") == front_door["frontDoorId"], f"lock-down {label}: FRONT_DOOR_ID {env.get('FRONT_DOOR_ID')!r}")
        # Not behind Front Door: ranges in the input open nothing and lock nothing.
        none = copy.deepcopy(data_in)
        none["frontDoor"] = {"mode": "none", "backendIpRanges": LOCKDOWN_RANGES}
        rc, log, data = snapshot(param_file, args, with_env("SAF_RELEASE_JSON", json.dumps(none)))
        apps = [r for r in (data or {}).get("predictedResources", []) if r.get("type") == "Microsoft.App/containerApps"]
        check(rc == 0 and len(apps) == 1 and not apps[0].get("properties", {}).get("configuration", {}).get("ingress", {}).get("ipSecurityRestrictions"),
              f"lock-down {label}: frontDoor.mode none must write no IP rules:\n{log[:600]}")
    print(f"lock-down: {len(LOCKDOWN_RANGES)} backend ranges through {len(cases)} parameter files (+ mode none)")


def with_env(name: str, value: str | None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("SAF_")}
    if value is not None:
        env[name] = value
    return env


def delivery_params() -> None:
    """infra/app/delivery/release.bicepparam: the delivery pipeline's only parameter file."""
    param_file = DELIVERY / "release.bicepparam"
    fixture = json.loads(DELIVERY_FIXTURE.read_text())

    def release(data: dict) -> tuple[int, str, dict | None]:
        return snapshot(param_file, DELIVERY_ARGS, with_env("SAF_RELEASE_JSON", json.dumps(data)))

    rc, log, data = release(fixture)
    check(rc == 0 and data is not None and not data.get("diagnostics"), f"delivery release snapshot failed:\n{log[:1500]}")

    # Keys a compromised input could add must not switch the template to provisioning mode.
    smuggled = copy.deepcopy(fixture)
    smuggled.update(deployedBy="provisioning", alertsEnabled=True)
    smuggled["image"]["bootstrapImage"] = "mcr.microsoft.com/k8se/quickstart:latest"
    rc, log, data = release(smuggled)
    check(rc == 0 and data is not None, f"delivery release with extra keys failed:\n{log[:1500]}")
    if data is not None:
        types = sorted({r.get("type", "") for r in data.get("predictedResources", [])})
        check(types == ["Microsoft.App/containerApps"],
              f"delivery release must write only the Container App, got {types}")
        apps = [r for r in data.get("predictedResources", []) if r.get("type") == "Microsoft.App/containerApps"]
        image = apps[0]["properties"]["template"]["containers"][0]["image"] if apps else ""
        # The login server is a runtime reference, so the snapshot keeps an expression here.
        check(fixture["image"]["digest"] in image and "quickstart" not in image,
              f"delivery release image is {image}, not the digest")

    for label, change, fragment in DELIVERY_NEGATIVE:
        case = copy.deepcopy(fixture)
        change(case)
        rc, log, _ = release(case)
        check(rc != 0 and fragment.lower() in log.lower(), f"delivery negative '{label}' did not fail with '{fragment}':\n{log[:600]}")

    rc, log, _ = snapshot(param_file, DELIVERY_ARGS, with_env("SAF_RELEASE_JSON", None))
    check(rc != 0 and "SAF_RELEASE_JSON" in log, f"delivery release without SAF_RELEASE_JSON did not fail:\n{log[:600]}")

    names_file = DELIVERY / "names.bicepparam"
    base = {"prefix": "contoso", "slug": "hotel-inventory", "environmentName": "nonprod"}
    expected = {
        "appResourceGroup": "rg-contoso-app-hotel-inventory-nonprod",
        "releaseDeployment": "release-hotel-inventory",
        "containerApp": "ca-hotel-inventory",
        "registryRepository": "hotel-inventory",
        "adoEnvironment": "hotel-inventory-nonprod",
        "adoServiceConnection": "sc-hotel-inventory-nonprod",
        "deliveryIdentity": "id-contoso-hotel-inventory-deploy-nonprod",
        "runtimeIdentity": "id-contoso-hotel-inventory-run-nonprod",
        "entraResourceGroup": "rg-contoso-entra",
        "entraEnvironmentResourceGroup": "rg-contoso-entra-nonprod",
        "platformResourceGroup": "rg-contoso-platform-nonprod",
        "easyAuthSecret": "easyauth-hotel-inventory",
    }
    # The Entra uniqueName (ADR-0061): null without incarnation (delivery never needs it), with it
    # {prefix}-{slug}-{env} for incarnation 0 and --i{n} above it.
    for incarnation, unique_name in ((None, None), (0, "contoso-hotel-inventory-nonprod"), (3, "contoso-hotel-inventory-nonprod--i3")):
        names_input = {**base, "generation": None} | ({} if incarnation is None else {"incarnation": incarnation})
        rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB], with_env("SAF_NAMES_JSON", json.dumps(names_input)))
        got = ((data or {}).get("outputs") or {}).get("entraApplicationUniqueName", "missing")
        check(rc == 0 and got == unique_name, f"delivery names: entraApplicationUniqueName with incarnation {incarnation} is {got}, expected {unique_name}\n{log[:400]}")
    rc, log, _ = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                          with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": None, "incarnation": -1})))
    check(rc != 0 and "minimum allowable value" in log.lower(), f"delivery names: incarnation -1 did not fail:\n{log[:600]}")
    for generation in (None, 0):
        rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                                 with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": generation})))
        outputs = (data or {}).get("outputs", {})
        check(rc == 0 and {k: outputs.get(k) for k in expected} == expected,
              f"delivery names (generation {generation}) differ: {outputs or log[:600]}")
        registry = outputs.get("containerRegistry")
        vault = outputs.get("appVault", "missing")
        if generation is None:
            check(registry is None, f"delivery names: containerRegistry must be null without generation, got {registry}")
            check(vault is None, f"delivery names: appVault must be null without generation, got {vault}")
        else:
            check(re.fullmatch(r"crcontosohotelinventorynonprod[a-z0-9]{6}", registry or "") is not None,
                  f"delivery names: unexpected containerRegistry {registry}")
            # The app vault as landing-zone-resources.bicep names it (appKeyVault, ADR-0064: the
            # soft-deleted vault check after a failed landing zone); another generation, another name.
            check(re.fullmatch(r"kvhotelinventory[a-z0-9]{6}", vault or "") is not None, f"delivery names: unexpected appVault {vault}")
            rc, log, bumped = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                                       with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": generation + 1})))
            other = ((bumped or {}).get("outputs") or {}).get("appVault")
            check(rc == 0 and re.fullmatch(r"kvhotelinventory[a-z0-9]{6}", other or "") is not None and other != vault,
                  f"delivery names: appVault of generation {generation + 1} must be another name than {vault}, got {other}\n{log[:400]}")
        for job_output in ("kvsetJob", "dbinitJob", "managedEnvironment"):
            check(outputs.get(job_output, "missing") is None,
                  f"delivery names: {job_output} must be null without networkMode, got {outputs.get(job_output, 'missing')}")

    # networkMode and cell (optional, provisioning): the kvset and dbinit jobs of the app's CAE (ADR-0035,
    # ADR-0028) and the CAE itself (the move of a network mode change, ADR-0060), in the capacity cell
    # (ADR-0053): cell 01 without a suffix, a later cell with -c{cell}; null without a cell.
    for mode, abbr in (("externalOnly", "ext"), ("externalHybrid", "hyb")):
        for cell, suffix in (("01", ""), ("02", "-c02")):
            rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                                     with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": None, "networkMode": mode, "cell": cell})))
            outputs = (data or {}).get("outputs", {})
            check(rc == 0 and outputs.get("kvsetJob") == f"caj-contoso-kvset-{abbr}{suffix}" and outputs.get("dbinitJob") == f"caj-contoso-dbinit-{abbr}{suffix}"
                  and outputs.get("managedEnvironment") == f"cae-contoso-{abbr}-nonprod{suffix}"
                  and {k: outputs.get(k) for k in expected} == expected,
                  f"delivery names ({mode}, cell {cell}): kvsetJob {outputs.get('kvsetJob')}, dbinitJob {outputs.get('dbinitJob')}, "
                  f"managedEnvironment {outputs.get('managedEnvironment')}; {log[:600]}")
    rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                             with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": None, "networkMode": "externalOnly"})))
    outputs = (data or {}).get("outputs", {})
    check(rc == 0 and all(outputs.get(k, "missing") is None for k in ("kvsetJob", "dbinitJob", "managedEnvironment")),
          f"delivery names: kvsetJob, dbinitJob and managedEnvironment must be null without a cell: {outputs or log[:600]}")
    for bad in ("00", "1"):
        rc, log, _ = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                              with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": None, "networkMode": "externalOnly", "cell": bad})))
        check(rc != 0, f"delivery names: cell {bad} did not fail:\n{log[:600]}")
    rc, log, _ = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                          with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": None, "networkMode": "internalOnly"})))
    check(rc != 0 and "'externalHybrid' | 'externalOnly'" in log,
          f"delivery names: networkMode internalOnly did not fail:\n{log[:600]}")

    # The portal-side endpoint of the app vault (provisioning, ADR-0025): its deployment always; the
    # portal resource group with portalEnvironmentName; the endpoint with vaultName.
    portal = {"portalEndpointDeployment": "pep-portal-hotel-inventory-nonprod", "portalResourceGroup": None,
              "portalVaultEndpoint": None}
    rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                             with_env("SAF_NAMES_JSON", json.dumps({**base, "generation": None})))
    outputs = (data or {}).get("outputs", {})
    check(rc == 0 and {k: outputs.get(k, "missing") for k in portal} == portal,
          f"delivery names: portal outputs without portalEnvironmentName and vaultName: {outputs or log[:600]}")
    with_portal = {**base, "generation": None, "portalEnvironmentName": "prod", "vaultName": "kvhotelinventoryab12cd"}
    rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB], with_env("SAF_NAMES_JSON", json.dumps(with_portal)))
    outputs = (data or {}).get("outputs", {})
    want = {"portalEndpointDeployment": "pep-portal-hotel-inventory-nonprod", "portalResourceGroup": "rg-contoso-portal-prod",
            "portalVaultEndpoint": "pep-kvhotelinventoryab12cd-portal"}
    check(rc == 0 and {k: outputs.get(k) for k in want} == want and {k: outputs.get(k) for k in expected} == expected,
          f"delivery names: portal outputs with portalEnvironmentName and vaultName: {outputs or log[:600]}")
    rc, log, _ = snapshot(names_file, ["--subscription-id", NONPROD_SUB],
                          with_env("SAF_NAMES_JSON", json.dumps({**with_portal, "portalEnvironmentName": "Prod"})))
    check(rc != 0 and "naming: invalid environment name" in log,
          f"delivery names: portalEnvironmentName Prod did not fail:\n{log[:600]}")
    print(f"delivery: release (+ extra keys, {len(DELIVERY_NEGATIVE) + 1} negative), names (9 cases, 3 negative)")


def check_names_environment_vault(snaps: dict[str, dict]) -> None:
    """names.bicep environmentVault (ADR-0060): with the inputs of each landing-zone example
    (networkMode, externalOnlyNetwork, vaultGeneration) it is exactly the example's output
    environmentKeyVaultName, so provisioning reads the Easy Auth secret where the landing zone puts it;
    the other variant names the other vault; null without the inputs it needs."""
    names_file = DELIVERY / "names.bicepparam"
    for rel, (env, sub) in LZ_EXAMPLES.items():
        text = (INFRA / rel).read_text()
        values = {k: re.search(rf"^param {k} = '?([A-Za-z0-9]+)'?$", text, re.M) for k in ("networkMode", "externalOnlyNetwork", "vaultGeneration")}
        check(all(values.values()), f"names environmentVault: {rel} lacks networkMode, externalOnlyNetwork or vaultGeneration")
        if not all(values.values()):
            continue
        mode, network, generation = values["networkMode"].group(1), values["externalOnlyNetwork"].group(1), int(values["vaultGeneration"].group(1))
        want = ((snaps.get(rel) or {}).get("outputs") or {}).get("environmentKeyVaultName")
        base = {"prefix": "contoso", "slug": "hotel-inventory", "environmentName": env, "generation": None, "vaultGeneration": generation}
        rc, log, data = snapshot(names_file, ["--subscription-id", sub],
                                 with_env("SAF_NAMES_JSON", json.dumps({**base, "networkMode": mode, "externalOnlyNetwork": network})))
        got = ((data or {}).get("outputs") or {}).get("environmentVault")
        check(rc == 0 and isinstance(want, str) and got == want,
              f"names environmentVault for {rel} is {got}, the landing zone's environmentKeyVaultName is {want}:\n{log[:400]}")
        other = {"networkMode": "externalOnly", "externalOnlyNetwork": "managed"} if mode == "externalHybrid" or network == "vnet" \
            else {"networkMode": "externalHybrid"}
        rc, log, data = snapshot(names_file, ["--subscription-id", sub], with_env("SAF_NAMES_JSON", json.dumps({**base, **other})))
        moved = ((data or {}).get("outputs") or {}).get("environmentVault")
        letter = "p" if other["networkMode"] == "externalOnly" else "n"
        check(rc == 0 and moved != got and re.fullmatch(rf"kvcontoso{env}{letter}[a-z0-9]{{5}}", moved or "") is not None,
              f"names environmentVault after a mode change ({rel}, {other}): {moved}\n{log[:400]}")
    base = {"prefix": "contoso", "slug": "hotel-inventory", "environmentName": "nonprod", "generation": None}
    for label, extra in (("without vaultGeneration", {"networkMode": "externalHybrid"}),
                         ("externalOnly without externalOnlyNetwork", {"networkMode": "externalOnly", "vaultGeneration": 0}),
                         ("without networkMode", {"vaultGeneration": 0, "externalOnlyNetwork": "managed"})):
        rc, log, data = snapshot(names_file, ["--subscription-id", NONPROD_SUB], with_env("SAF_NAMES_JSON", json.dumps({**base, **extra})))
        check(rc == 0 and ((data or {}).get("outputs") or {}).get("environmentVault", "missing") is None,
              f"names environmentVault must be null {label}: {((data or {}).get('outputs') or {}).get('environmentVault', 'missing')}\n{log[:400]}")
    print(f"names environmentVault: {len(LZ_EXAMPLES)} landing-zone examples, their other variant, 3 null cases")


def check_entra_assignments(rel: str, data: dict) -> None:
    """ADR-0023 mitigation: every app role assignment targets the app's own service principal
    and one of the app's own roles, never Microsoft Graph or another resource."""
    resources = data.get("predictedResources", [])
    apps = [r for r in resources if r.get("type", "").startswith("Microsoft.Graph/applications@")]
    role_ids = {ar["id"] for a in apps for ar in a.get("properties", {}).get("appRoles", [])}
    assignments = [r for r in resources if r.get("type", "").startswith("Microsoft.Graph/appRoleAssignedTo@")]
    check(bool(assignments), f"{rel}: example has no appRoleAssignedTo to check")
    for a in assignments:
        props = a.get("properties", {})
        check(props.get("resourceId") == "[reference('servicePrincipal').id]",
              f"{rel}: appRoleAssignedTo targets {props.get('resourceId')}, not the app's own service principal")
        check(props.get("appRoleId") in role_ids, f"{rel}: appRoleAssignedTo uses a role id outside the app's roles")
    print(f"entra assignments: {len(assignments)} checked in {rel}")

    # ADR-0023 amendment: the only consent the template grants is openid/profile/email on
    # Microsoft Graph, for all users, to the app's own service principal.
    grants = [r for r in resources if r.get("type", "").startswith("Microsoft.Graph/oauth2PermissionGrants@")]
    expected = {"clientId": "[reference('servicePrincipal').id]", "consentType": "AllPrincipals",
                "resourceId": "[reference('graphServicePrincipal').id]", "scope": "openid profile email"}
    check(len(grants) == 1 and grants[0].get("properties") == expected,
          f"{rel}: expected exactly one sign-in consent grant {expected}, got {[g.get('properties') for g in grants]}")


def check_entra_unique_name(where: str, param_file: Path, var: str, fixture: dict, args: list[str], data: dict) -> None:
    """ADR-0061: the application's uniqueName is {prefix}-{slug}-{env} for incarnation 0 (the name every
    existing registration has), {prefix}-{slug}-{env}--i{n} above it: a new app with a deleted app's slug
    gets its own registration, and its app role ids (guid(uniqueName, ...)) differ too."""
    def application(d: dict | None) -> dict:
        apps = [r for r in (d or {}).get("predictedResources", []) if r.get("type", "").startswith("Microsoft.Graph/applications@")]
        return apps[0].get("properties", {}) if len(apps) == 1 else {}

    first = f"{fixture['prefix']}-{fixture['slug']}-{fixture['environmentName']}"
    a = application(data)
    check(fixture.get("incarnation") == 0 and a.get("uniqueName") == first,
          f"{where}: uniqueName {a.get('uniqueName')} with incarnation {fixture.get('incarnation')}, expected {first}")
    rc, log, later = snapshot(param_file, args, with_env(var, json.dumps({**fixture, "incarnation": 2})))
    b = application(later)
    check(rc == 0 and b.get("uniqueName") == f"{first}--i2", f"{where}: uniqueName {b.get('uniqueName')} with incarnation 2, expected {first}--i2\n{log[:400]}")
    ids_a = {r.get("id") for r in a.get("appRoles", [])}
    ids_b = {r.get("id") for r in b.get("appRoles", [])}
    check(bool(ids_a) and len(ids_b) == len(ids_a) and not ids_a & ids_b, f"{where}: app role ids of incarnation 0 and 2 must differ: {sorted(ids_a & ids_b)}")


def check_entra_graph_reference(compiled: dict[str, dict], name: str = "app-registration.bicep") -> None:
    """The consent grant's (or the Graph permissions') resource must be Microsoft Graph's own
    service principal."""
    template = compiled.get(name)
    if template is None:
        return
    graph = template.get("resources", {}).get("graphServicePrincipal", {})
    app_id = graph.get("properties", {}).get("appId")
    if app_id == "[variables('graphAppId')]":
        app_id = template.get("variables", {}).get("graphAppId")
    check(graph.get("existing") is True and app_id == GRAPH_APP_ID,
          f"{name}: graphServicePrincipal must be the existing Microsoft Graph service principal, got {graph}")
    print(f"{name}: Graph service principal checked")


def check_entra_no_defaults(compiled: dict[str, dict], name: str = "app-registration.bicep") -> None:
    """entra_plan compares the parameters `bicep build-params` writes with the deployment record
    (ADR-0033, no preflight): a parameter with a default would be missing from them, so none may
    have one."""
    template = compiled.get(name)
    if template is None:
        return
    defaults = sorted(n for n, p in template.get("parameters", {}).items() if "defaultValue" in p)
    check(not defaults, f"{name}: parameters with a default break the Entra plan's comparison (ADR-0033): {defaults}")
    print(f"{name}: no parameter defaults")


def check_entra_audit_alert(snaps: dict[str, dict]) -> None:
    """entra-audit-alert.bicep (ADR-0023, US06.04): exactly the two log search alerts on the
    workspace, for the identity the parameter names, notifying exactly the given action groups."""
    text = (INFRA / ENTRA_AUDIT_ALERT_EXAMPLE).read_text()
    principal = re.search(r"param entraProvisioningPrincipalId = '([^']+)'", text)
    workspace = re.search(r"param workspaceResourceId = '([^']+)'", text)
    groups = re.findall(r"'(/subscriptions/[^']+/actionGroups/[^']+)'", text)
    predicted = (snaps.get(ENTRA_AUDIT_ALERT_EXAMPLE) or {}).get("predictedResources", [])
    rules = {r.get("name"): r for r in predicted}
    check({r.get("type") for r in predicted} == {"Microsoft.Insights/scheduledQueryRules"}
          and sorted(rules) == ["alert-contoso-entra-consent", "alert-contoso-entra-tier0"],
          f"entra-audit-alert: expected the rules tier0 and consent only, got {sorted(map(str, rules))}")
    if principal is None or workspace is None or len(rules) != 2:
        return
    for name, severity, operation in (("alert-contoso-entra-tier0", 0, "Add app role assignment to service principal"),
                                      ("alert-contoso-entra-consent", 1, "Add delegated permission grant")):
        props = rules[name].get("properties", {})
        query = props.get("criteria", {}).get("allOf", [{}])[0].get("query", "")
        check(props.get("severity") == severity and props.get("enabled") is True, f"entra-audit-alert {name}: severity or enabled")
        check(props.get("scopes") == [workspace.group(1)], f"entra-audit-alert {name}: scopes {props.get('scopes')}")
        check(props.get("actions", {}).get("actionGroups") == groups, f"entra-audit-alert {name}: action groups")
        check(f'== "{principal.group(1).lower()}"' in query and operation in query and "__PRINCIPAL__" not in query,
              f"entra-audit-alert {name}: the query must filter on the identity and the operation:\n{query}")
    print("entra-audit-alert: two rules on the workspace, for the identity, to the action groups")


def check_entra_permissions(compiled: dict[str, dict], snaps: dict[str, dict]) -> None:
    """entra-permissions.bicep: exactly the four Graph application permissions, resource always
    the Microsoft Graph service principal, principal always the parameter, nothing else."""
    name = "entra-permissions.bicep"
    check_entra_graph_reference(compiled, name)
    resources = (compiled.get(name) or {}).get("resources", {})
    types = sorted(str(v.get("type")) for v in resources.values())
    check(types == ["Microsoft.Graph/appRoleAssignedTo@v1.0", "Microsoft.Graph/servicePrincipals@v1.0"],
          f"{name}: expected one appRoleAssignedTo loop and the existing Graph service principal, got {types}")

    def assignments(label: str, data: dict | None, principal: str) -> None:
        predicted = (data or {}).get("predictedResources", [])
        types = {r.get("type") for r in predicted}
        check(types == {"Microsoft.Graph/appRoleAssignedTo@v1.0"}, f"{name} {label}: unexpected resources {sorted(map(str, types))}")
        role_ids = sorted(r.get("properties", {}).get("appRoleId", "") for r in predicted)
        check(role_ids == sorted(ENTRA_GRAPH_PERMISSIONS),
              f"{name} {label}: app roles {role_ids}, expected exactly {sorted(ENTRA_GRAPH_PERMISSIONS.values())}")
        for r in predicted:
            props = r.get("properties", {})
            check(props.get("resourceId") == "[reference('graphServicePrincipal').id]",
                  f"{name} {label}: assignment on {props.get('resourceId')}, not the Microsoft Graph service principal")
            check(props.get("principalId") == principal, f"{name} {label}: principal {props.get('principalId')}, expected {principal}")

    text = (INFRA / ENTRA_PERMISSIONS_EXAMPLE).read_text()
    m = re.search(r"param entraProvisioningPrincipalId = '([^']+)'", text)
    check(m is not None, f"{ENTRA_PERMISSIONS_EXAMPLE}: entraProvisioningPrincipalId not found")
    if m is None:
        return
    assignments("example", snaps.get(ENTRA_PERMISSIONS_EXAMPLE), m.group(1))

    # The principal is the parameter: another value moves every assignment, and nothing else changes.
    other = "00000000-0000-0000-0000-00000000d1ff"
    with tempfile.TemporaryDirectory(prefix="saf-entra-permissions-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
        case = (work / ENTRA_PERMISSIONS_EXAMPLE).with_name("principal-case.bicepparam")
        case.write_text(text.replace(m.group(1), other))
        rc, log, data = snapshot(case, EXAMPLES[ENTRA_PERMISSIONS_EXAMPLE])
        check(rc == 0 and data is not None, f"{name} principal variant failed:\n{log[:1500]}")
        assignments("principal variant", data, other)
    print(f"{name}: {len(ENTRA_GRAPH_PERMISSIONS)} Graph permissions checked (example + principal variant)")


def check_roles(compiled: dict[str, dict]) -> None:
    roles = compiled.get("roles.bicep")
    if roles is None:
        return
    variables = roles.get("variables", {})
    for var in ("appDeployerActions", "appEnvironmentJoinerActions", "platformJobSecretWriterActions"):
        actions = variables.get(var, [])
        check(bool(actions), f"roles.bicep: variable {var} missing")
        bad = [a for a in actions if FORBIDDEN_ACTION.search(a)]
        check(not bad, f"roles.bicep {var}: forbidden actions {bad}")
    text = (INFRA / "platform" / "roles.bicep").read_text()
    check(re.search(r"dataActions: \[\s*\]", text) is not None, "roles.bicep: dataActions must be empty")
    print("roles: checked")


def role_guid(assignment: dict) -> str:
    return str(assignment.get("properties", {}).get("roleDefinitionId", "")).rsplit("/", 1)[-1].lower()


def custom_role_definitions(snaps: dict[str, dict]) -> dict[str, dict]:
    """Role definitions of the Contoso roles example, by role name."""
    roles = snaps.get(ROLES_EXAMPLE, {})
    return {str(r.get("properties", {}).get("roleName")): r for r in roles.get("predictedResources", [])
            if r.get("type") == "Microsoft.Authorization/roleDefinitions"}


def job_secret_writer_guid(snaps: dict[str, dict]) -> str:
    return str((custom_role_definitions(snaps).get(JOB_SECRET_WRITER_ROLE_NAME) or {}).get("name", "")).lower()


def platform_role_set(snaps: dict[str, dict]) -> set[str]:
    """types.builtInRoles (read from the source text) + the two delivery roles of the Contoso
    roles example (same tenant and prefix as every other example). Platform Job Secret Writer is
    defined there too but is NOT in the set (ADR-0035)."""
    text = (INFRA / "modules" / "types.bicep").read_text()
    block = re.search(r"var builtInRoles = \{(.*?)\n\}", text, re.S)
    built_in = {g.lower() for g in GUID.findall(block.group(1))} if block else set()
    check(len(built_in) >= 2, "types.bicep: builtInRoles not found")
    definitions = custom_role_definitions(snaps)
    want = sorted(DELIVERY_ROLE_NAMES + [JOB_SECRET_WRITER_ROLE_NAME])
    check(sorted(definitions) == want, f"contoso-roles example: expected custom roles {want}, got {sorted(definitions)}")
    custom = {str(definitions[n].get("name", "")).lower() for n in DELIVERY_ROLE_NAMES if n in definitions}
    return built_in | custom


def check_job_secret_writer_role(snaps: dict[str, dict], allowed: set[str]) -> None:
    """Platform Job Secret Writer (roles.bicep, ADR-0035): exactly the six job actions, no
    notActions or data actions, the environment subscriptions as assignable scopes, never in the
    provisioning identity's role set."""
    d = custom_role_definitions(snaps).get(JOB_SECRET_WRITER_ROLE_NAME)
    check(d is not None, f"{ROLES_EXAMPLE}: no role definition {JOB_SECRET_WRITER_ROLE_NAME}")
    if d is None:
        return
    props = d.get("properties", {})
    perms = props.get("permissions", [])
    check(props.get("type") == "CustomRole", f"{JOB_SECRET_WRITER_ROLE_NAME}: type {props.get('type')}")
    check(len(perms) == 1 and sorted(perms[0].get("actions", [])) == sorted(JOB_SECRET_WRITER_ACTIONS)
          and not any(perms[0].get(k) for k in ("notActions", "dataActions", "notDataActions")),
          f"{JOB_SECRET_WRITER_ROLE_NAME}: permissions {perms}, expected only {JOB_SECRET_WRITER_ACTIONS}")
    want_scopes = [f"/subscriptions/{NONPROD_SUB}", f"/subscriptions/{PROD_SUB}"]
    check(props.get("assignableScopes") == want_scopes,
          f"{JOB_SECRET_WRITER_ROLE_NAME}: assignable scopes {props.get('assignableScopes')}, expected {want_scopes}")
    guid = str(d.get("name", "")).lower()
    check(GUID.fullmatch(guid) is not None and guid not in allowed,
          f"{JOB_SECRET_WRITER_ROLE_NAME} {guid} must be a GUID outside the provisioning identity's unrestricted role set")
    print(f"{JOB_SECRET_WRITER_ROLE_NAME}: actions, assignable scopes, outside the unrestricted role set")


def string_values(node: object):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from string_values(k)
            yield from string_values(v)
    elif isinstance(node, list):
        for v in node:
            yield from string_values(v)


def check_bootstrap(compiled: dict[str, dict], snaps: dict[str, dict]) -> None:
    allowed = platform_role_set(snaps)
    forbidden = {ROLE_OWNER, ROLE_USER_ACCESS_ADMINISTRATOR, ROLE_RBAC_ADMINISTRATOR}
    check(not allowed & forbidden, f"platform role set contains {sorted(allowed & forbidden)}")
    # ADR-0059: the registry purge role is the one types.bicep exports, and never in the unrestricted set.
    types_text = (INFRA / "modules" / "types.bicep").read_text()
    check(re.search(rf"^var registryPurgeRole = '{ROLE_REGISTRY_PURGE}'$", types_text, re.M) is not None,
          f"types.bicep: registryPurgeRole must be '{ROLE_REGISTRY_PURGE}' (Container Registry Repository Contributor)")
    check(ROLE_REGISTRY_PURGE not in allowed, "the registry purge role must not be in the platform role set (builtInRoles)")
    check_job_secret_writer_role(snaps, allowed)
    writer = job_secret_writer_guid(snaps)

    # Every GUID literal in the compiled app/platform templates is a platform role, except the
    # RBAC Administrator role bootstrap.bicep assigns (that one literal, nowhere else) and the
    # portal's two limited roles in bootstrap.bicep's condition and environment.bicep.
    for name in ROLE_SCAN_TEMPLATES:
        template = compiled.get(name)
        check(template is not None, f"role scan: {name} not compiled")
        literals = {g.lower() for s in string_values(template or {}) for g in GUID.findall(s)}
        if name == "bootstrap.bicep":
            check(ROLE_RBAC_ADMINISTRATOR in literals, "bootstrap.bicep: RBAC Administrator role not found")
            literals.discard(ROLE_RBAC_ADMINISTRATOR)
            check(PORTAL_ENVIRONMENT_ROLES <= literals, "bootstrap.bicep: the portal's limited roles are not in its condition")
            literals -= PORTAL_ENVIRONMENT_ROLES
            check(ROLE_REGISTRY_PURGE in literals, "bootstrap.bicep: the registry purge role (ADR-0059) is not in its condition")
            literals.discard(ROLE_REGISTRY_PURGE)
        if name == "landing-zone.bicep":
            check(ROLE_REGISTRY_PURGE in literals, "landing-zone.bicep: the registry purge role (ADR-0059) is not assigned")
            literals.discard(ROLE_REGISTRY_PURGE)
        if name == "environment.bicep":
            check(ROLE_LOG_ANALYTICS_READER in literals, "environment.bicep: Log Analytics Reader (portal logs) not found")
            check(ROLE_COST_MANAGEMENT_READER in literals, "environment.bicep: Cost Management Reader (portal costs) not found")
            literals -= PORTAL_ENVIRONMENT_ROLES
        check(literals <= allowed, f"{name}: GUID literals outside the platform role set: {sorted(literals - allowed)}")

    # Every role assignment the app/platform examples predict (custom role GUIDs are computed,
    # so only the snapshot shows them) is a platform role.
    for rel, data in snaps.items():
        if not (rel.startswith("app/") or rel.startswith("platform/")):
            continue
        # Entra Deployment Operator: defined and assigned by bootstrap.bicep only (checked in
        # check_bootstrap_snapshot), never in the platform role set.
        defined_here = {r["name"].lower() for r in data.get("predictedResources", [])
                        if r.get("type") == "Microsoft.Authorization/roleDefinitions"} if rel in BOOTSTRAP_EXAMPLES else set()
        for a in data.get("predictedResources", []):
            if a.get("type") != "Microsoft.Authorization/roleAssignments":
                continue
            guid = role_guid(a)
            if rel in BOOTSTRAP_EXAMPLES and (guid == ROLE_RBAC_ADMINISTRATOR or guid in defined_here):
                continue
            # Platform Job Secret Writer: environment.bicep only, on kvset jobs only, to the Entra
            # provisioning identity only (check_kvset_jobs); outside the role set on purpose.
            if rel in ENVIRONMENT_EXAMPLES and writer and guid == writer:
                continue
            # Log Analytics Reader and Cost Management Reader: environment.bicep only, on the
            # workspace and the subscription, to the portal identity (check_portal_readers).
            if rel in ENVIRONMENT_EXAMPLES and guid in PORTAL_ENVIRONMENT_ROLES:
                continue
            # The registry purge role: landing zones only, to their deployer only (check_registry_purge_role).
            if guid == ROLE_REGISTRY_PURGE and rel in LZ_EXAMPLES:
                continue
            check(guid in allowed, f"{rel}: role assignment {a.get('name')} uses role {guid}, outside the platform role set")

    for rel, (instance_identities, federated, env) in BOOTSTRAP_EXAMPLES.items():
        data = snaps.get(rel)
        if data is not None:
            check_bootstrap_snapshot(rel, data, allowed, instance_identities, federated, env, writer)

    # Pass 1 in the portal host subscription: ADO automation identity, no federated credentials.
    with tempfile.TemporaryDirectory(prefix="saf-bootstrap-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
        rel = "platform/examples/contoso-bootstrap-prod.bicepparam"
        text, n = re.subn(r"param federation = \{.*?\n\}", "param federation = {}", (work / rel).read_text(), flags=re.S)
        check(n == 1, f"bootstrap pass-1 variant: federation block not found in {rel}")
        case = (work / rel).with_name("pass1-case.bicepparam")
        case.write_text(text)
        rc, log, data = snapshot(case, EXAMPLES[rel])
        check(rc == 0 and data is not None, f"bootstrap pass-1 variant failed:\n{log[:1500]}")
        if data is not None:
            check_bootstrap_snapshot("prod pass 1", data, allowed, True, False, "prod", writer)

    # The lock comes last: it depends on every identity, federated credential and role
    # assignment of the identities module.
    template = compiled.get("bootstrap.bicep") or {}
    module = template.get("resources", {}).get("identities", {}).get("properties", {}).get("template", {})
    resources = module.get("resources", {})
    locks = {k: v for k, v in resources.items() if v.get("type") == "Microsoft.Authorization/locks"}
    must_precede = {k for k, v in resources.items() if v.get("type") in (
        "Microsoft.ManagedIdentity/userAssignedIdentities",
        "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",
        "Microsoft.Authorization/roleAssignments")}
    check(len(locks) == 1, f"bootstrap identities module: expected one lock, got {sorted(locks)}")
    want_precede = {"provisioningIdentity", "provisioningFic", "adoAutomationIdentity", "adoAutomationFic",
                    "adoAutomationReader", "entraProvisioningIdentity", "entraProvisioningFic", "portalIdentity"}
    check(want_precede <= must_precede,
          f"bootstrap identities module: expected identities, FICs and Reader {sorted(want_precede)}, got {sorted(must_precede)}")
    # The Entra provisioning identity has no role in its identities RG (its only Azure role is on
    # rg-{prefix}-entra); the portal identity has none at all here (portal.bicep assigns its one).
    for name, r in resources.items():
        if r.get("type") == "Microsoft.Authorization/roleAssignments":
            check("entraProvisioning" not in json.dumps(r),
                  f"bootstrap identities module: role assignment {name} is for the Entra provisioning identity")
            check("portalIdentity" not in json.dumps(r),
                  f"bootstrap identities module: role assignment {name} is for the portal identity")
    for name, lock in locks.items():
        check(lock.get("properties", {}).get("level") == "ReadOnly", f"bootstrap lock {name} is not ReadOnly")
        check("condition" not in lock, f"bootstrap lock {name} must be unconditional")
        missing = must_precede - set(lock.get("dependsOn", []))
        check(not missing, f"bootstrap lock {name} does not depend on {sorted(missing)}")
    print(f"bootstrap: {len(BOOTSTRAP_EXAMPLES)} examples + pass-1 variant, role set of {len(allowed)}, lock order checked")


def check_host_condition(label: str, cond: str, allowed: set[str], writer: str, entra_role: str, host: bool = True) -> None:
    """The RBAC Administrator condition (ADR-0043, ADR-0059): an ARM format() (the provisioning identity's
    own principal is the identities module's output, so the snapshot keeps it an expression) whose role
    lists are exactly the unrestricted set, the portal's two readers, Platform Job Secret Writer and the
    registry purge role; the readers' principal is the portal identity and the writer's the Entra
    provisioning identity (in the portal host this deployment's identities, the module's outputs;
    elsewhere instancePrincipals, literals), and the purge role's this deployment's provisioning
    identity, in both clauses."""
    check(cond.startswith("[format('({0}) AND ({1})', format('(!(ActionMatches{{''Microsoft.Authorization/roleAssignments/write''}}))"),
          f"bootstrap {label}: RBAC Administrator condition is not the expected expression: {cond[:200]}")
    # The subscription in the identities module's resourceId() is no role list.
    args = re.sub(r"resourceId\('[0-9a-fA-F-]{36}'", "resourceId(", cond)
    lists = [frozenset(x.lower().split(", ")) for x in re.findall(
        r"'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:, [0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"
        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})*)'", args)]
    want = {frozenset(allowed), frozenset(PORTAL_ENVIRONMENT_ROLES), frozenset({writer}), frozenset({ROLE_REGISTRY_PURGE})}
    if not host:
        want |= {frozenset({EXAMPLE_PORTAL_PRINCIPAL}), frozenset({EXAMPLE_ENTRA_PRINCIPAL})}
    check(set(lists) == want, f"bootstrap {label}: the condition's role lists are {sorted(map(sorted, set(lists)))}, expected the unrestricted set, the portal readers, Platform Job Secret Writer and the registry purge role"
          + ("" if host else " (and the instancePrincipals)"))
    check(not any(entra_role in s or ROLE_OWNER in s or ROLE_USER_ACCESS_ADMINISTRATOR in s or ROLE_RBAC_ADMINISTRATOR in s for s in lists),
          f"bootstrap {label}: the condition lists a forbidden role")
    check(cond.count("ForAnyOfAnyValues:GuidEquals") == 14 and cond.count("roleAssignments:PrincipalId") == 6,
          f"bootstrap {label}: each clause needs the unrestricted set and the three principal-limited roles")
    # Once in the write clause and once in the delete clause: the purge role's list, then this deployment's
    # provisioning identity (ADR-0059: it may assign the role to itself only).
    check(cond.count(f"'{ROLE_REGISTRY_PURGE}', reference(") == 2 and cond.count(".outputs.provisioningPrincipalId.value") == 2,
          f"bootstrap {label}: the registry purge role must be limited to this deployment's provisioning identity")
    if host:
        check(cond.count("outputs, 'portalPrincipalId'") == 2 and cond.count("outputs, 'entraProvisioningPrincipalId'") == 2,
              f"bootstrap {label}: the limited roles must name this deployment's portal and Entra provisioning identities")
    else:
        readers = re.findall(rf"'([0-9a-f-]{{36}}, [0-9a-f-]{{36}})', '{EXAMPLE_PORTAL_PRINCIPAL}'", cond)
        check(len(readers) == 2 and all(set(r.split(", ")) == PORTAL_ENVIRONMENT_ROLES for r in readers),
              f"bootstrap {label}: the portal readers must be limited to {EXAMPLE_PORTAL_PRINCIPAL}")
        check(cond.count(f"'{writer}', '{EXAMPLE_ENTRA_PRINCIPAL}'") == 2,
              f"bootstrap {label}: Platform Job Secret Writer must be limited to {EXAMPLE_ENTRA_PRINCIPAL}")


def check_bootstrap_snapshot(label: str, data: dict, allowed: set[str], instance_identities: bool,
                             federated: bool, env: str, writer: str) -> None:
    resources = data.get("predictedResources", [])
    sub = next((r["id"].split("/resourceGroups/")[0] for r in resources if r.get("type") == "Microsoft.Resources/resourceGroups"), "")
    rg = f"{sub}/resourceGroups/rg-contoso-identities-{env}"

    def of_type(t: str) -> list[dict]:
        return [r for r in resources if r.get("type") == t]

    entra_rg = f"{sub}/resourceGroups/rg-contoso-entra"
    # ADR-0063: the Entra records group of every environment of the example instance, in the host.
    entra_env_rgs = [f"{sub}/resourceGroups/rg-contoso-entra-{e}" for e in ("nonprod", "prod")] if instance_identities else []
    entra_scopes = [entra_rg, *entra_env_rgs]
    rgs = {r["id"] for r in of_type("Microsoft.Resources/resourceGroups")}
    want_rgs = {rg} | (set(entra_scopes) if instance_identities else set())
    check(rgs == want_rgs, f"bootstrap {label}: resource groups {sorted(rgs)}, expected {sorted(want_rgs)}")

    identities = {r["name"] for r in of_type("Microsoft.ManagedIdentity/userAssignedIdentities")}
    want_identities = {f"id-contoso-provisioning-{env}"} | (
        {"id-contoso-ado-automation", "id-contoso-entra-provisioning", "id-contoso-portal"} if instance_identities else set())
    check(identities == want_identities, f"bootstrap {label}: identities {sorted(identities)}, expected {sorted(want_identities)}")

    fics = of_type("Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials")
    want_fics = set()
    if federated:
        want_fics = {f"id-contoso-provisioning-{env}/sc-platform-provisioning-{env}"}
        if instance_identities:
            want_fics |= {"id-contoso-ado-automation/sc-platform-ado", "id-contoso-entra-provisioning/sc-platform-entra"}
    check({f["name"] for f in fics} == want_fics,
          f"bootstrap {label}: federated credentials {sorted(f['name'] for f in fics)}, expected {sorted(want_fics)}")
    for f in fics:
        check(f.get("properties", {}).get("audiences") == ["api://AzureADTokenExchange"],
              f"bootstrap {label}: {f['name']} audiences {f.get('properties', {}).get('audiences')}")

    # Entra Deployment Operator (portal host only): exactly the two actions, nothing else,
    # assignable only at rg-contoso-entra and the environments' Entra records groups (ADR-0063),
    # never in the platform role set.
    role_defs = of_type("Microsoft.Authorization/roleDefinitions")
    entra_role = ""
    check(len(role_defs) == (1 if instance_identities else 0),
          f"bootstrap {label}: role definitions {[r.get('name') for r in role_defs]}, expected {1 if instance_identities else 0}")
    if instance_identities and len(role_defs) == 1:
        d = role_defs[0]
        props = d.get("properties", {})
        entra_role = str(d.get("name", "")).lower()
        check(GUID.fullmatch(entra_role) is not None
              and d.get("id") == f"{sub}/providers/Microsoft.Authorization/roleDefinitions/{entra_role}",
              f"bootstrap {label}: Entra Deployment Operator id {d.get('id')}")
        check(props.get("roleName") == "Entra Deployment Operator (contoso)" and props.get("type") == "CustomRole",
              f"bootstrap {label}: role definition {props.get('roleName')} ({props.get('type')})")
        perms = props.get("permissions", [])
        check(len(perms) == 1 and sorted(perms[0].get("actions", [])) == sorted(ENTRA_ROLE_ACTIONS)
              and not any(perms[0].get(k) for k in ("notActions", "dataActions", "notDataActions")),
              f"bootstrap {label}: Entra Deployment Operator permissions {perms}, expected only {ENTRA_ROLE_ACTIONS}")
        check(props.get("assignableScopes") == entra_scopes,
              f"bootstrap {label}: Entra Deployment Operator assignable scopes {props.get('assignableScopes')}, expected only {entra_scopes}")
        check(entra_role not in allowed, f"bootstrap {label}: Entra Deployment Operator {entra_role} is in the platform role set")

    # (scope, role) of every assignment: exactly Contributor and conditioned RBAC Administrator at
    # the subscription, plus Reader on the identities RG for the ADO automation identity and
    # Entra Deployment Operator on rg-contoso-entra and each environment's Entra records group
    # (ADR-0063) for the Entra provisioning identity.
    got = sorted((a["id"].split("/providers/Microsoft.Authorization/roleAssignments/")[0], role_guid(a))
                 for a in of_type("Microsoft.Authorization/roleAssignments"))
    want = sorted([(sub, ROLE_CONTRIBUTOR), (sub, ROLE_RBAC_ADMINISTRATOR)]
                  + ([(rg, ROLE_READER)] + [(scope, entra_role) for scope in entra_scopes] if instance_identities else []))
    check(got == want, f"bootstrap {label}: role assignments {got}, expected {want}")
    # The Entra provisioning identity holds those assignments (one per Entra group) and no other.
    entra_held = sorted((a["id"].split("/providers/Microsoft.Authorization/roleAssignments/")[0], role_guid(a))
                        for a in of_type("Microsoft.Authorization/roleAssignments")
                        if "entraProvisioning" in str(a.get("properties", {}).get("principalId"))
                        or "id-contoso-entra-provisioning" in str(a.get("properties", {}).get("principalId")))
    want_entra_held = sorted((scope, entra_role) for scope in entra_scopes) if instance_identities else []
    check(entra_held == want_entra_held, f"bootstrap {label}: Entra provisioning identity roles {entra_held}, expected {want_entra_held}")
    # The portal identity holds no role from the bootstrap and has no federated credential (W1).
    portal_held = [a["id"] for a in of_type("Microsoft.Authorization/roleAssignments")
                   if "portal" in str(a.get("properties", {}).get("principalId")).lower()]
    check(not portal_held, f"bootstrap {label}: the portal identity holds roles {portal_held}")
    for a in of_type("Microsoft.Authorization/roleAssignments"):
        props = a.get("properties", {})
        check(props.get("principalType") == "ServicePrincipal" and bool(props.get("description")),
              f"bootstrap {label}: {a['name']} needs principalType ServicePrincipal and a description")
        if role_guid(a) != ROLE_RBAC_ADMINISTRATOR:
            check("condition" not in props, f"bootstrap {label}: unexpected condition on {a['name']}")
            continue
        check(props.get("conditionVersion") == "2.0", f"bootstrap {label}: RBAC Administrator conditionVersion must be 2.0")
        cond = str(props.get("condition", ""))
        # The provisioning identity's own principal (ADR-0059), and in the portal host the portal and Entra
        # provisioning identities, are this deployment's module outputs, so the snapshot keeps the condition
        # an ARM expression in every subscription.
        if cond.startswith("[format("):
            check_host_condition(label, cond, allowed, writer, entra_role, instance_identities)
            continue
        m = RBAC_CONDITION.fullmatch(cond)
        check(m is not None, f"bootstrap {label}: RBAC Administrator condition has an unexpected shape: {cond}")
        if m is None:
            continue
        guids = lambda group: [g.strip().lower() for g in group.split(",")]  # noqa: E731
        for clause, (platform, portal_roles, portal_principal, writer_roles, entra_principal) in (
                ("write", m.groups()[0:5]), ("delete", m.groups()[5:10])):
            items = guids(platform)
            check(all(GUID.fullmatch(g) for g in items) and len(items) == len(set(items)),
                  f"bootstrap {label}: {clause} role list is not a list of distinct GUIDs: {platform}")
            check(set(items) == allowed,
                  f"bootstrap {label}: {clause} unrestricted role set differs from the platform role set: "
                  f"extra {sorted(set(items) - allowed)}, missing {sorted(allowed - set(items))}")
            check(not entra_role or entra_role not in items,
                  f"bootstrap {label}: {clause} role set contains Entra Deployment Operator {entra_role}")
            check(not writer or writer not in items,
                  f"bootstrap {label}: {clause} unrestricted role set contains Platform Job Secret Writer {writer}")
            check(not PORTAL_ENVIRONMENT_ROLES & set(items),
                  f"bootstrap {label}: {clause} unrestricted role set contains a portal role (Log Analytics Reader, Cost Management Reader)")
            # ADR-0043: the limited roles, each only for its one principal (instancePrincipals of the example).
            check(set(guids(portal_roles)) == PORTAL_ENVIRONMENT_ROLES and guids(portal_principal) == [EXAMPLE_PORTAL_PRINCIPAL],
                  f"bootstrap {label}: {clause} the portal readers must be limited to {EXAMPLE_PORTAL_PRINCIPAL}: {portal_roles} / {portal_principal}")
            check(guids(writer_roles) == [writer] and guids(entra_principal) == [EXAMPLE_ENTRA_PRINCIPAL],
                  f"bootstrap {label}: {clause} Platform Job Secret Writer must be limited to {EXAMPLE_ENTRA_PRINCIPAL}: {writer_roles} / {entra_principal}")

    locks = of_type("Microsoft.Authorization/locks")
    check(len(locks) == 1 and locks[0]["id"] == f"{rg}/providers/Microsoft.Authorization/locks/lock-contoso-identities-readonly"
          and locks[0].get("properties", {}).get("level") == "ReadOnly",
          f"bootstrap {label}: expected one ReadOnly lock lock-contoso-identities-readonly on {rg}, got {locks}")

    outputs = data.get("outputs", {})
    check(outputs.get("identitiesResourceGroup") == f"rg-contoso-identities-{env}",
          f"bootstrap {label}: identitiesResourceGroup output {outputs.get('identitiesResourceGroup')}")
    ado = outputs.get("adoAutomationIdentity")
    check((ado is not None) == instance_identities, f"bootstrap {label}: adoAutomationIdentity output {ado}")
    entra = outputs.get("entraProvisioningIdentity")
    check((entra is not None) == instance_identities
          and (entra is None or "id-contoso-entra-provisioning" in str(entra) and "entraProvisioningPrincipalId" in str(entra)),
          f"bootstrap {label}: entraProvisioningIdentity output {entra}")
    portal = outputs.get("portalIdentity")
    check((portal is not None) == instance_identities
          and (portal is None or "id-contoso-portal" in str(portal) and "portalPrincipalId" in str(portal)),
          f"bootstrap {label}: portalIdentity output {portal}")
    want_entra_rg = "rg-contoso-entra" if instance_identities else None
    check(outputs.get("entraResourceGroup") == want_entra_rg,
          f"bootstrap {label}: entraResourceGroup output {outputs.get('entraResourceGroup')}, expected {want_entra_rg}")
    want_entra_env_rgs = {e: f"rg-contoso-entra-{e}" for e in ("nonprod", "prod")} if instance_identities else None
    check(outputs.get("entraEnvironmentResourceGroups") == want_entra_env_rgs,
          f"bootstrap {label}: entraEnvironmentResourceGroups output {outputs.get('entraEnvironmentResourceGroups')}, expected {want_entra_env_rgs}")
    # The nested deployments of the role assignments are never named like an app's Entra record
    # entra-{slug}-{env} (ADR-0063: the plan reads the records groups' deployments by name).
    nested = [r.get("name", "") for r in of_type("Microsoft.Resources/deployments")]
    check(not any(str(n).startswith("entra-") for n in nested), f"bootstrap {label}: a nested deployment is named entra-*: {nested}")


def check_kvset_jobs(snaps: dict[str, dict]) -> None:
    """environment.bicep (ADR-0035): pass 2 of both environment examples, and a pass-1 variant
    of each (empty digest) that must create no job and no Platform Job Secret Writer assignment."""
    writer = job_secret_writer_guid(snaps)
    check(GUID.fullmatch(writer) is not None, f"Platform Job Secret Writer GUID not found in {ROLES_EXAMPLE}")
    for rel, (env, variants) in ENVIRONMENT_EXAMPLES.items():
        text = (INFRA / rel).read_text()
        principal = re.search(r"^param entraProvisioningPrincipalId = '([^']+)'$", text, re.M)
        digest = re.search(r"^param platformJobsImageDigest = '(sha256:[0-9a-f]{64})'$", text, re.M)
        check(principal is not None and digest is not None,
              f"{rel}: entraProvisioningPrincipalId or a pass-2 platformJobsImageDigest not found")
        if principal is None or digest is None:
            continue
        check_kvset_snapshot(rel, snaps.get(rel), env, variants, principal.group(1), digest.group(1), writer)
        with tempfile.TemporaryDirectory(prefix="saf-kvset-") as tmp:
            work = Path(tmp) / "infra"
            shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
            shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
            case = (work / rel).with_name("pass1-case.bicepparam")
            case.write_text(text.replace(digest.group(0), "param platformJobsImageDigest = ''"))
            rc, log, data = snapshot(case, EXAMPLES[rel])
            check(rc == 0 and data is not None, f"{rel} pass 1 (empty digest) failed:\n{log[:1500]}")
            check_kvset_snapshot(f"{rel} pass 1", data, env, {}, principal.group(1), "", writer)
    print(f"platform jobs (kvset, dbinit): {len(ENVIRONMENT_EXAMPLES)} environment examples, pass 2 and pass 1")


def check_kvset_snapshot(label: str, data: dict | None, env: str, variants: dict[str, str], principal: str,
                         digest: str, writer: str) -> None:
    """variants: CAE mode abbreviation -> expected vault variant letter of its kvset job; empty
    in pass 1 (no jobs)."""
    resources = (data or {}).get("predictedResources", [])
    if not resources:
        failures.append(f"{label}: no predicted resources")
        return
    sub = resources[0]["id"].split("/resourceGroups/")[0]
    rg = f"{sub}/resourceGroups/rg-contoso-platform-{env}"
    kvset_identity = f"{rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-kvset-{env}"

    def of_type(t: str) -> list[dict]:
        return [r for r in resources if r.get("type") == t]

    # Platform registry: exactly one, same settings as app registries, Repository Reader for the
    # kvset identity (principalIds[1] of the job identities module) and no other role on it.
    registries = of_type("Microsoft.ContainerRegistry/registries")
    check(len(registries) == 1, f"{label}: expected one platform registry, got {[r.get('name') for r in registries]}")
    registry = registries[0]["name"] if registries else ""
    reg_props = registries[0].get("properties", {}) if registries else {}
    check(re.fullmatch(rf"crcontoso{env}[a-z0-9]{{6}}", registry) is not None
          and registries[0]["id"] == f"{rg}/providers/Microsoft.ContainerRegistry/registries/{registry}",
          f"{label}: platform registry {registry} is not cr{{prefix}}{{env}}{{h6}} in the platform RG")
    check(registries and registries[0].get("sku", {}).get("name") == "Basic"
          and reg_props.get("adminUserEnabled") is False and reg_props.get("anonymousPullEnabled") is False
          and reg_props.get("roleAssignmentMode") == "AbacRepositoryPermissions",
          f"{label}: platform registry settings {registries[0] if registries else None}")
    # The job identities module lists dbinit, kvset, recov: principalIds[0] is dbinit, [1] kvset.
    assignments = of_type("Microsoft.Authorization/roleAssignments")
    on_registry = [a for a in assignments if a["id"].startswith(f"{rg}/providers/Microsoft.ContainerRegistry/registries/")]
    readers = sorted(str(a.get("properties", {}).get("principalId")).rsplit(".outputs.", 1)[-1] for a in on_registry
                     if role_guid(a) == ROLE_REPOSITORY_READER and "jobIdentities" in str(a.get("properties", {}).get("principalId")))
    check(len(on_registry) == 2 and readers == ["principalIds.value[0]]", "principalIds.value[1]]"],
          f"{label}: expected only Repository Reader for the dbinit and kvset identities on the platform registry, got {on_registry}")
    # dbinit's only role here is that one: its administrator role comes from each landing zone.
    dbinit_held = [a["id"] for a in assignments if str(a.get("properties", {}).get("principalId")).endswith(".outputs.principalIds.value[0]]")]
    check(len(dbinit_held) == 1, f"{label}: the dbinit identity holds other roles: {dbinit_held}")

    def check_job(name: str, mode: str, identity_id: str, step: str) -> dict:
        """The settings every platform job shares; returns its one container ({} if missing)."""
        job = jobs[name]
        where = f"{label} {name}"
        check(job["id"] == f"{rg}/providers/Microsoft.App/jobs/{name}", f"{where}: not in the platform RG: {job['id']}")
        identity = job.get("identity", {})
        check(identity.get("type") == "UserAssigned" and list(identity.get("userAssignedIdentities", {})) == [identity_id],
              f"{where}: identities {identity}, expected only {identity_id}")
        props = job.get("properties", {})
        cfg = props.get("configuration", {})
        check(props.get("environmentId") == f"{rg}/providers/Microsoft.App/managedEnvironments/cae-contoso-{mode}-{env}"
              and props.get("workloadProfileName") == "Consumption",
              f"{where}: CAE {props.get('environmentId')} / profile {props.get('workloadProfileName')}")
        check(cfg.get("triggerType") == "Manual"
              and cfg.get("manualTriggerConfig") == {"parallelism": 1, "replicaCompletionCount": 1}
              and cfg.get("replicaTimeout") == 300 and cfg.get("replicaRetryLimit") == 0
              and not any(k in cfg for k in ("scheduleTriggerConfig", "eventTriggerConfig", "ingress")),
              f"{where}: configuration {json.dumps({k: v for k, v in cfg.items() if k != 'registries'})}")
        check(cfg.get("secrets") in (None, []), f"{where}: secrets at deploy time {cfg.get('secrets')}")
        registries_cfg = cfg.get("registries", [])
        check(len(registries_cfg) == 1 and registries_cfg[0].get("identity") == identity_id
              and f"/registries/{registry}'" in str(registries_cfg[0].get("server")),
              f"{where}: registries {registries_cfg}, expected the platform registry {registry} with the {step} identity")
        containers = props.get("template", {}).get("containers", [])
        check(len(containers) == 1 and not props.get("template", {}).get("initContainers"),
              f"{where}: expected exactly one container, got {len(containers)}")
        if not containers:
            return {}
        c = containers[0]
        check(f"/registries/{registry}'" in str(c.get("image")) and f"'saf-jobs', '{digest}')]" in str(c.get("image")),
              f"{where}: image {c.get('image')}, expected {{platform registry}}/saf-jobs@{digest}")
        check(c.get("args") == [step] and "command" not in c, f"{where}: args {c.get('args')} command {c.get('command')}")
        return c

    # Jobs: one kvset and one dbinit job per enabled CAE (pass 2), none in pass 1.
    jobs = {j["name"]: j for j in of_type("Microsoft.App/jobs")}
    want_kvset = {f"caj-contoso-kvset-{m}": m for m in variants}
    want_dbinit = {f"caj-contoso-dbinit-{m}": m for m in variants}
    check(sorted(jobs) == sorted([*want_kvset, *want_dbinit]),
          f"{label}: platform jobs {sorted(jobs)}, expected {sorted([*want_kvset, *want_dbinit])}")
    dbinit_identity = f"{rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-dbinit-{env}"
    for name, mode in want_dbinit.items():
        if name not in jobs:
            continue
        where = f"{label} {name}"
        c = check_job(name, mode, dbinit_identity, "dbinit")
        env_vars = {e.get("name"): e for e in c.get("env", [])}
        check(sorted(env_vars) == sorted(DBINIT_ENV) and len(c.get("env", [])) == len(DBINIT_ENV)
              and not any("secretRef" in e for e in c.get("env", [])),
              f"{where}: env {sorted(env_vars)}, expected exactly {DBINIT_ENV} without secretRef")
        audience = str(env_vars.get("SAF_PG_AUDIENCE", {}).get("value"))
        check(audience.startswith("[format('https://ossrdbms-aad{0}'") and "environment().suffixes.sqlServerHostname" in audience,
              f"{where}: SAF_PG_AUDIENCE {audience} must be https://ossrdbms-aad + environment().suffixes.sqlServerHostname")
        sql_suffix = str(env_vars.get("SAF_SQL_HOST_SUFFIX", {}).get("value"))
        check(sql_suffix.startswith("[substring(environment().suffixes.sqlServerHostname, 1"),
              f"{where}: SAF_SQL_HOST_SUFFIX {sql_suffix} must be environment().suffixes.sqlServerHostname without its dot")
        check(env_vars.get("SAF_PG_HOST_SUFFIX", {}).get("value") == "postgres.database.azure.com"
              and env_vars.get("SAF_DB_ADMIN", {}).get("value") == f"id-contoso-dbinit-{env}",
              f"{where}: SAF_PG_HOST_SUFFIX / SAF_DB_ADMIN {env_vars.get('SAF_PG_HOST_SUFFIX')} {env_vars.get('SAF_DB_ADMIN')}")
        client = str(env_vars.get("AZURE_CLIENT_ID", {}).get("value"))
        check("jobIdentities" in client and client.endswith(".outputs.clientIds.value[0]]"),
              f"{where}: AZURE_CLIENT_ID {client} is not the dbinit identity's client ID")
    for name, mode in want_kvset.items():
        if name not in jobs:
            continue
        where = f"{label} {name}"
        c = check_job(name, mode, kvset_identity, "kvset")
        env_vars = {e.get("name"): e for e in c.get("env", [])}
        check(sorted(env_vars) == sorted(KVSET_ENV) and len(c.get("env", [])) == len(KVSET_ENV)
              and not any("secretRef" in e for e in c.get("env", [])),
              f"{where}: env {sorted(env_vars)}, expected exactly {KVSET_ENV} without secretRef")
        vault = re.fullmatch(rf"\[reference\('{re.escape(rg)}/providers/Microsoft\.KeyVault/vaults/(kvcontoso{env}([pn])[a-z0-9]{{5}})', "
                             r"'[0-9-]+'\)\.vaultUri\]", str(env_vars.get("SAF_VAULT_URI", {}).get("value")))
        check(vault is not None and vault.group(2) == variants.get(mode),
              f"{where}: SAF_VAULT_URI {env_vars.get('SAF_VAULT_URI')} is not the vaultUri of the "
              f"{'public' if variants.get(mode) == 'p' else 'private'} environment vault")
        audience = str(env_vars.get("SAF_VAULT_AUDIENCE", {}).get("value"))
        check(audience.startswith("[format('https://{0}'") and "environment().suffixes.keyvaultDns" in audience,
              f"{where}: SAF_VAULT_AUDIENCE {audience} must be https:// + environment().suffixes.keyvaultDns")
        client = str(env_vars.get("AZURE_CLIENT_ID", {}).get("value"))
        check("jobIdentities" in client and client.endswith(".outputs.clientIds.value[1]]"),
              f"{where}: AZURE_CLIENT_ID {client} is not the kvset identity's client ID")

    # Platform Job Secret Writer: exactly one assignment per job, at the job, to the Entra
    # provisioning identity; that identity holds nothing else here.
    writer_assignments = [a for a in assignments if role_guid(a) == writer]
    want_scopes = sorted(j["id"] for n, j in jobs.items() if n in want_kvset)
    got_scopes = sorted(a["id"].split("/providers/Microsoft.Authorization/roleAssignments/")[0] for a in writer_assignments)
    check(got_scopes == want_scopes, f"{label}: Platform Job Secret Writer at {got_scopes}, expected exactly at {want_scopes}")
    for a in writer_assignments:
        props = a.get("properties", {})
        check(props.get("principalId") == principal and props.get("principalType") == "ServicePrincipal"
              and "condition" not in props and bool(props.get("description")),
              f"{label}: Platform Job Secret Writer assignment {a['name']} to {props.get('principalId')}, expected {principal}")
    held = [a["id"] for a in assignments if str(a.get("properties", {}).get("principalId")).lower() == principal.lower()]
    check(len(held) == len(writer_assignments), f"{label}: the Entra provisioning identity holds other roles: {held}")

    outputs = (data or {}).get("outputs", {})
    check("platformRegistry" in outputs and "kvsetJobs" in outputs and "dbinitJobs" in outputs,
          f"{label}: outputs platformRegistry/kvsetJobs/dbinitJobs missing")
    if not variants:
        for out in ("kvsetJobs", "dbinitJobs"):
            check(outputs.get(out) == {"externalOnly": None, "externalHybrid": None},
                  f"{label}: {out} output {outputs.get(out)}, expected both null in pass 1")


# Managed Front Door (profile.bicep, ADR-0010). The rule sets a Premium WAF policy carries.
FD_NO_RULE_SETS: list[dict] = []
FD_PREMIUM_RULE_SETS = [
    {"ruleSetType": "Microsoft_DefaultRuleSet", "ruleSetVersion": "2.1", "ruleSetAction": "Block"},
    {"ruleSetType": "Microsoft_BotManagerRuleSet", "ruleSetVersion": "1.1"},
]
FD_PARAM = re.compile(r"^param frontDoor = \{.*?^\}\n", re.S | re.M)
FD_NONPROD = "platform/examples/contoso-nonprod.bicepparam"
FD_PROD = "platform/examples/contoso-prod.bicepparam"
# What the examples declare: (SKU, WAF mode or None for no WAF policy, managed rule sets).
FD_EXAMPLE_EXPECTED = {
    FD_NONPROD: ("Standard", "Detection", FD_NO_RULE_SETS),
    FD_PROD: ("Premium", "Prevention", FD_PREMIUM_RULE_SETS),
}


def fd_param(env: str, sku: str | None = None, mode: str | None = None, rules: bool | None = None) -> str:
    """A `param frontDoor` declaration; omitted values take the defaults of the environment kind."""
    lines = [f"  environment: '{env}'"]
    if sku is not None:
        lines.append(f"  sku: '{sku}'")
    if mode is not None or rules is not None:
        lines.append("  waf: {")
        if mode is not None:
            lines.append(f"    mode: '{mode}'")
        if rules is not None:
            lines.append(f"    managedRuleSets: {str(rules).lower()}")
        lines.append("  }")
    return "param frontDoor = {\n" + "\n".join(lines) + "\n}\n"


# (label, example, replacement of the example's `param frontDoor` declaration, expectation): a tuple
# (SKU, WAF mode or None, managed rule sets), None = no Front Door at all, or a message fragment that
# the snapshot must fail with.
FD_VARIANTS: list[tuple[str, str, str, tuple | str | None]] = [
    ("nonprod: frontDoor null", FD_NONPROD, "param frontDoor = null\n", None),
    ("nonprod: frontDoor omitted", FD_NONPROD, "", None),
    ("nonprod: kind defaults", FD_NONPROD, fd_param("nonprod"), ("Standard", "Detection", FD_NO_RULE_SETS)),
    ("nonprod: Premium takes the managed rule sets by default", FD_NONPROD, fd_param("nonprod", sku="Premium"),
     ("Premium", "Detection", FD_PREMIUM_RULE_SETS)),
    ("nonprod: Premium prevention without managed rule sets", FD_NONPROD, fd_param("nonprod", "Premium", "prevention", False),
     ("Premium", "Prevention", FD_NO_RULE_SETS)),
    ("nonprod: WAF off", FD_NONPROD, fd_param("nonprod", mode="off"), ("Standard", None, FD_NO_RULE_SETS)),
    ("prod: frontDoor null", FD_PROD, "param frontDoor = null\n", None),
    ("prod: Standard prevents without managed rule sets", FD_PROD, fd_param("prod", sku="Standard"),
     ("Standard", "Prevention", FD_NO_RULE_SETS)),
    ("prod: WAF off", FD_PROD, fd_param("prod", mode="off"), ("Premium", None, FD_NO_RULE_SETS)),
    ("nonprod: profile of prod", FD_NONPROD, fd_param("prod"), 'frontDoor profile belongs to environment "prod", not "nonprod".'),
    ("prod: profile of nonprod", FD_PROD, fd_param("nonprod"), 'frontDoor profile belongs to environment "nonprod", not "prod".'),
    ("prod: managed rule sets on Standard", FD_PROD, fd_param("prod", "Standard", None, True),
     "Front Door managed rule sets need the Premium tier"),
    ("nonprod: unknown SKU", FD_NONPROD, fd_param("nonprod", sku="Basic"), "'Premium' | 'Standard' | null"),
    ("nonprod: unknown WAF mode", FD_NONPROD, fd_param("nonprod", mode="block"), "'detection' | 'off' | 'prevention' | null"),
    ("nonprod: environment missing", FD_NONPROD, "param frontDoor = {\n  sku: 'Standard'\n}\n",
     'missing the following required properties: "environment"'),
]


def check_front_door(snaps: dict[str, dict]) -> None:
    """environment.bicep (ADR-0010): the two environment examples as declared, and the variants of
    FD_VARIANTS (snapshots run in parallel, each in its own copy of the example)."""
    texts = {rel: (INFRA / rel).read_text() for rel in FD_EXAMPLE_EXPECTED}
    missing = [rel for rel, text in texts.items() if FD_PARAM.search(text) is None]
    for rel in missing:
        failures.append(f"{rel}: `param frontDoor = {{ ... }}` declaration not found")
    if missing:
        return
    baseline: dict[str, list[str]] = {}
    with tempfile.TemporaryDirectory(prefix="saf-fd-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")

        def run_variant(i: int) -> tuple[int, str, dict | None]:
            _, rel, declaration, _ = FD_VARIANTS[i]
            case = (work / rel).with_name(f"fd-case-{i}.bicepparam")
            case.write_text(FD_PARAM.sub(lambda _: declaration, texts[rel], count=1))
            try:
                return snapshot(case, EXAMPLES[rel])
            finally:
                case.unlink()

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run_variant, range(len(FD_VARIANTS))))

    # The platform without a Front Door is the baseline: a profile adds its own resources and
    # changes nothing else.
    for (_, rel, _, expected), (_, _, data) in zip(FD_VARIANTS, results):
        if expected is None and data is not None and rel not in baseline:
            baseline[rel] = sorted(r["id"] for r in data["predictedResources"])
    for rel in FD_EXAMPLE_EXPECTED:
        check(rel in baseline, f"{rel}: no frontDoor null variant to compare with")

    for (label, rel, _, expected), (rc, log, data) in zip(FD_VARIANTS, results):
        env = ENVIRONMENT_EXAMPLES[rel][0]
        if isinstance(expected, str):
            check(rc != 0 and expected.lower() in log.lower(), f"Front Door '{label}' did not fail with '{expected}':\n{log[:600]}")
            continue
        check(rc == 0 and data is not None and not data.get("diagnostics"), f"Front Door '{label}' failed:\n{log[:1500]}")
        if data is not None:
            check_front_door_snapshot(f"Front Door '{label}'", data, env, expected, baseline.get(rel, []))
    for rel, expected in FD_EXAMPLE_EXPECTED.items():
        check_front_door_snapshot(f"Front Door {rel}", snaps.get(rel), ENVIRONMENT_EXAMPLES[rel][0], expected, baseline.get(rel, []))
    print(f"front door: {len(FD_EXAMPLE_EXPECTED)} examples, {len(FD_VARIANTS)} variants")


def check_front_door_snapshot(label: str, data: dict | None, env: str, expected: tuple | None, baseline: list[str]) -> None:
    resources = (data or {}).get("predictedResources", [])
    if not resources:
        failures.append(f"{label}: no predicted resources")
        return
    sub = resources[0]["id"].split("/resourceGroups/")[0]
    rg = f"{sub}/resourceGroups/rg-contoso-platform-{env}"
    outputs = (data or {}).get("outputs", {})

    def is_front_door(r: dict) -> bool:
        return (r["type"].startswith("Microsoft.Cdn/") or r["type"] == "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies"
                or "/providers/Microsoft.Cdn/profiles/" in r["id"])

    fd = [r for r in resources if is_front_door(r)]
    other_ids = sorted(r["id"] for r in resources if not is_front_door(r))
    check(other_ids == baseline, f"{label}: the Front Door changes other resources: "
          f"{sorted(set(other_ids) ^ set(baseline))}")
    if expected is None:
        check(not fd, f"{label}: expected no Front Door resources, got {[r['id'] for r in fd]}")
        check(outputs.get("frontDoor") is None, f"{label}: frontDoor output {outputs.get('frontDoor')}, expected null")
        return

    sku, mode, rule_sets = expected
    sku_name = f"{sku}_AzureFrontDoor"
    profile_id = f"{rg}/providers/Microsoft.Cdn/profiles/afd-contoso-{env}"
    endpoint_id = f"{profile_id}/afdEndpoints/fde-contoso-{env}"
    waf_id = f"{rg}/providers/Microsoft.Network/FrontDoorWebApplicationFirewallPolicies/wafcontoso{env}"
    # Per-app origin groups, origins, routes and custom domains come from frontdoor.bicep: nothing but
    # these. Both examples set portalIdentityPrincipalId, so the portal's Reader on the profile is one
    # of them (check_portal_readers checks its principal and the case without the portal).
    want_types = ["Microsoft.Cdn/profiles", "Microsoft.Cdn/profiles/afdEndpoints", "Microsoft.Insights/diagnosticSettings",
                  "Microsoft.Authorization/roleAssignments"]
    if mode is not None:
        want_types += ["Microsoft.Cdn/profiles/securityPolicies", "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies"]
    check(sorted(r["type"] for r in fd) == sorted(want_types),
          f"{label}: Front Door resource types {sorted(r['type'] for r in fd)}, expected {sorted(want_types)}")

    def one(rtype: str) -> dict:
        found = [r for r in fd if r["type"] == rtype]
        return found[0] if len(found) == 1 else {}

    reader = one("Microsoft.Authorization/roleAssignments")
    check(role_guid(reader) == ROLE_READER if reader else False,
          f"{label}: the role assignment on the profile is {reader.get('id')}, expected the portal's Reader")
    profile, endpoint = one("Microsoft.Cdn/profiles"), one("Microsoft.Cdn/profiles/afdEndpoints")
    check(profile.get("id") == profile_id and profile.get("location") == "global" and profile.get("sku") == {"name": sku_name}
          and profile.get("tags", {}).get("Environment") == env,
          f"{label}: profile {profile.get('id')} / {profile.get('location')} / {profile.get('sku')}, expected {profile_id} global {sku_name}")
    check(endpoint.get("id") == endpoint_id and endpoint.get("location") == "global"
          and endpoint.get("properties", {}).get("enabledState") == "Enabled",
          f"{label}: endpoint {endpoint.get('id')} / {endpoint.get('location')}, expected {endpoint_id} global")

    waf, security = one("Microsoft.Network/FrontDoorWebApplicationFirewallPolicies"), one("Microsoft.Cdn/profiles/securityPolicies")
    if mode is None:
        check(not waf and not security, f"{label}: WAF off still creates a WAF policy or a security policy")
    else:
        settings = waf.get("properties", {})
        check(waf.get("id") == waf_id and waf.get("location") == "global" and waf.get("sku") == {"name": sku_name},
              f"{label}: WAF policy {waf.get('id')} / {waf.get('location')} / {waf.get('sku')}, expected {waf_id} global {sku_name}")
        check(settings.get("policySettings") == {"enabledState": "Enabled", "mode": mode, "requestBodyCheck": "Enabled"},
              f"{label}: WAF policySettings {settings.get('policySettings')}, expected mode {mode}")
        check(settings.get("customRules") == {"rules": []}, f"{label}: WAF custom rules {settings.get('customRules')}")
        check(settings.get("managedRules") == {"managedRuleSets": rule_sets},
              f"{label}: WAF managed rules {settings.get('managedRules')}, expected {rule_sets}")
        check(security.get("id") == f"{profile_id}/securityPolicies/secp-contoso-{env}"
              and security.get("properties", {}).get("parameters") == {
                  "type": "WebApplicationFirewall",
                  "wafPolicy": {"id": waf_id},
                  "associations": [{"domains": [{"id": endpoint_id}], "patternsToMatch": ["/*"]}],
              },
              f"{label}: security policy {security.get('id')} {security.get('properties')}, expected the WAF policy "
              f"associated with the endpoint {endpoint_id} (only) on /*")

    # Diagnostics: all logs to the environment workspace, the same one the other diagnostic settings use.
    diag = one("Microsoft.Insights/diagnosticSettings")
    diag_props = diag.get("properties", {})
    workspaces = {r["properties"].get("workspaceId") for r in resources
                  if r["type"] == "Microsoft.Insights/diagnosticSettings" and not is_front_door(r)}
    workspace = diag_props.get("workspaceId")
    check(diag.get("id") == f"{profile_id}/providers/Microsoft.Insights/diagnosticSettings/diag-contoso-{env}"
          and diag.get("name") == f"diag-contoso-{env}"
          and diag_props.get("logs") == [{"categoryGroup": "allLogs", "enabled": True}]
          and diag_props.get("logAnalyticsDestinationType") == "Dedicated"
          and set(diag_props) == {"workspaceId", "logAnalyticsDestinationType", "logs"},
          f"{label}: diagnostic setting {diag}")
    check(workspaces == {workspace} and str(workspace).startswith(
              f"[reference(resourceId('{sub.rsplit('/', 1)[-1]}', 'rg-contoso-platform-{env}', 'Microsoft.Resources/deployments', format('workspace-{{0}}'")
          and str(workspace).endswith(".outputs.id.value]"),
          f"{label}: diagnostics go to {workspace}, the other diagnostic settings to {workspaces}: not the environment workspace")

    out = str(outputs.get("frontDoor"))
    check(all(key in out for key in ("'profileId'", "'frontDoorId'", "'endpointHostName'"))
          and f"'sku', '{sku}', 'wafMode', '{'off' if mode is None else mode.lower()}'" in out,
          f"{label}: frontDoor output {out}")


# One app on its custom domain through the managed Front Door (infra/app/frontdoor.bicep, ADR-0010
# amended 2026-11-01). The example writes its DNS records in a zone of the nonprod subscription.
FDA_EXAMPLE = "app/examples/hotel-inventory-nonprod.frontdoor.bicepparam"
FDA_HOST = "hotel-inventory-test.contoso.com"
FDA_ZONE = ("/subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-dns/providers/Microsoft.Network/"
            "dnsZones/contoso.com")
FDA_ZONE_LINE = f"param dnsZoneId = '{FDA_ZONE}'\n"
FDA_PROD_ARGS = ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-platform-prod",
                 "--deployment-name", "fd-hotel-inventory-prod"]
# What the example declares; variants override single keys.
FDA_EXPECTED = {"env": "nonprod", "mode": "ext", "host": FDA_HOST, "zone": FDA_ZONE, "record": "hotel-inventory-test", "retained": None}
FDA_RETAINED_LINE = "param retainedHostName = ''\n"
# Nothing of the app route may link (or even name) a WAF policy or create a security policy: the
# environment's WAF policy is linked by secp-{prefix}-{env}, and Front Door refuses a second link in
# the same profile ("Web Application Firewall Policy is already attached to AFDX profile.", sandbox
# 2026-11-01, ADR-0010 amended 2026-11-01).
FDA_FORBIDDEN = ("frontdoorwebapplicationfirewallpolicies", "securitypolicies")


def fda_host(host: str) -> tuple[str, str]:
    return (f"param hostName = '{FDA_HOST}'", f"param hostName = '{host}'")


# (label, text replacements in the example, snapshot arguments or None for the example's, expectation):
# a dict of FDA_EXPECTED overrides, or a message fragment the snapshot must fail with.
FDA_VARIANTS: list[tuple[str, list[tuple[str, str]], list[str] | None, dict | str]] = [
    ("manual DNS", [(FDA_ZONE_LINE, "param dnsZoneId = ''\n")], None, {"zone": None}),
    # A host change (ADR-0010, amended 2026-11-11): the previous domain stays on the route, untouched.
    ("host change: the previous domain stays on the route",
     [(FDA_RETAINED_LINE, "param retainedHostName = 'hotel-inventory-old.contoso.com'\n"),
      ("param retainedDnsZoneId = ''", f"param retainedDnsZoneId = '{FDA_ZONE}'")], None,
     {"retained": "hotel-inventory-old.contoso.com"}),
    ("host change: the retained host equals the new one", [(FDA_RETAINED_LINE, f"param retainedHostName = '{FDA_HOST}'\n")], None,
     "retainedHostName must differ from hostName"),
    ("host change: a retained zone without a retained host",
     [("param retainedDnsZoneId = ''", f"param retainedDnsZoneId = '{FDA_ZONE}'")], None,
     "retainedDnsZoneId must be '' without a retainedHostName"),
    ("host change: an upper-case retained host", [(FDA_RETAINED_LINE, "param retainedHostName = 'Old.contoso.com'\n")], None,
     "must be '' or a lowercase host name"),
    ("retainedHostName has no default", [(FDA_RETAINED_LINE, "")], None, 'missing an assignment in the params file: "retainedHostName"'),
    ("zone ID in lower case, as instance.yaml writes it", [("Microsoft.Network/dnsZones", "microsoft.network/dnszones")], None,
     {"zone": FDA_ZONE.replace("Microsoft.Network/dnsZones", "microsoft.network/dnszones")}),
    ("subdomain of two labels", [fda_host("hotel-inventory.apps.contoso.com")], None,
     {"host": "hotel-inventory.apps.contoso.com", "record": "hotel-inventory.apps"}),
    ("prod, hybrid CAE, manual DNS",
     [("param environmentName = 'nonprod'", "param environmentName = 'prod'"),
      ("param networkMode = 'externalOnly'", "param networkMode = 'externalHybrid'"),
      fda_host("hotel-inventory.contoso.com"), (FDA_ZONE_LINE, "param dnsZoneId = ''\n")], FDA_PROD_ARGS,
     {"env": "prod", "mode": "hyb", "host": "hotel-inventory.contoso.com", "zone": None}),
    ("host outside the zone", [fda_host("hotel-inventory-test.fabrikam.com")], None,
     'hostName "hotel-inventory-test.fabrikam.com" is not below the DNS zone "contoso.com"'),
    ("host at the zone apex", [fda_host("apps.contoso.com"), ("dnsZones/contoso.com", "dnsZones/apps.contoso.com")], None,
     'hostName "apps.contoso.com" is not below the DNS zone "apps.contoso.com"'),
    ("zone in another subscription", [("a001/resourceGroups/rg-dns", "d001/resourceGroups/rg-dns")], None,
     "not in this deployment's: pass '' and create the records by hand"),
    ("private DNS zone", [("dnsZones/contoso.com", "privateDnsZones/contoso.com")], None,
     "dnsZoneId must be '' or the resource ID of a public Azure DNS zone"),
    ("zone name instead of a zone ID", [(FDA_ZONE_LINE, "param dnsZoneId = 'contoso.com'\n")], None,
     "dnsZoneId must be '' or the resource ID of a public Azure DNS zone"),
    ("wildcard host", [fda_host("*.apps.contoso.com")], None, "must be a lowercase host name with at least three labels"),
    ("upper-case host", [fda_host("Hotel-inventory-test.contoso.com")], None, "must be a lowercase host name"),
    ("host with a scheme", [fda_host(f"https://{FDA_HOST}")], None, "must be a lowercase host name"),
    ("host with a trailing dot", [fda_host(f"{FDA_HOST}.")], None, "must be a lowercase host name"),
    ("two-label host without a zone", [fda_host("contoso.com"), (FDA_ZONE_LINE, "param dnsZoneId = ''\n")], None,
     "must be a lowercase host name with at least three labels"),
    ("another resource group", [], ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-app-hotel-inventory-nonprod",
                                    "--deployment-name", "fd-hotel-inventory-nonprod"],
     "deploy into the environment's platform resource group rg-contoso-platform-nonprod"),
    ("another deployment name", [], ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-platform-nonprod",
                                     "--deployment-name", "frontdoor"],
     "the deployment name must be fd-hotel-inventory-nonprod"),
    ("unknown network mode", [("param networkMode = 'externalOnly'", "param networkMode = 'internalOnly'")], None,
     "'externalHybrid' | 'externalOnly'"),
    ("dnsZoneId has no default", [(FDA_ZONE_LINE, "")], None, 'missing an assignment in the params file: "dnsZoneId"'),
    ("the removed wafEnabled parameter", [("param networkMode = 'externalOnly'\n", "param networkMode = 'externalOnly'\nparam wafEnabled = true\n")],
     None, 'The parameter "wafEnabled" is assigned in the params file without being declared'),
]


def check_front_door_app(compiled: dict[str, dict], snaps: dict[str, dict]) -> None:
    """infra/app/frontdoor.bicep: no WAF link in the compiled template, the example as declared and the
    variants of FDA_VARIANTS (snapshots run in parallel, each in its own copy of the example)."""
    template = json.dumps(compiled.get("frontdoor.bicep", {})).lower()
    check("frontdoor.bicep" in compiled and not any(word in template for word in FDA_FORBIDDEN),
          f"frontdoor.bicep (with its modules) must not create a security policy or reference a WAF policy: "
          f"{[word for word in FDA_FORBIDDEN if word in template]}")
    check_front_door_app_snapshot(f"Front Door app {FDA_EXAMPLE}", snaps.get(FDA_EXAMPLE), FDA_EXPECTED)
    text = (INFRA / FDA_EXAMPLE).read_text()
    with tempfile.TemporaryDirectory(prefix="saf-fda-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")

        def run_variant(i: int) -> tuple[int, str, dict | None]:
            label, replacements, args, _ = FDA_VARIANTS[i]
            case_text = text
            for old, new in replacements:
                if old not in case_text:
                    return 1, f"marker '{old[:60]}' not found in {FDA_EXAMPLE}", None
                case_text = case_text.replace(old, new, 1)
            case = (work / FDA_EXAMPLE).with_name(f"fda-case-{i}.bicepparam")
            case.write_text(case_text)
            try:
                return snapshot(case, args or EXAMPLES[FDA_EXAMPLE])
            finally:
                case.unlink()

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run_variant, range(len(FDA_VARIANTS))))

    for (label, _, _, expected), (rc, log, data) in zip(FDA_VARIANTS, results):
        if isinstance(expected, str):
            check(rc != 0 and expected.lower() in log.lower(), f"Front Door app '{label}' did not fail with '{expected}':\n{log[:600]}")
            continue
        check(rc == 0 and data is not None and not data.get("diagnostics"), f"Front Door app '{label}' failed:\n{log[:1500]}")
        if data is not None:
            check_front_door_app_snapshot(f"Front Door app '{label}'", data, {**FDA_EXPECTED, **expected})
    print(f"front door app: 1 example, {len(FDA_VARIANTS)} variants")


def check_front_door_app_snapshot(label: str, data: dict | None, exp: dict) -> None:
    resources = (data or {}).get("predictedResources", [])
    if not resources:
        failures.append(f"{label}: no predicted resources")
        return
    env, host, zone = exp["env"], exp["host"], exp["zone"]
    sub = NONPROD_SUB if env == "nonprod" else PROD_SUB
    rg = f"/subscriptions/{sub}/resourceGroups/rg-contoso-platform-{env}"
    profile_id = f"{rg}/providers/Microsoft.Cdn/profiles/afd-contoso-{env}"
    endpoint_id = f"{profile_id}/afdEndpoints/fde-contoso-{env}"
    og_id = f"{profile_id}/originGroups/og-hotel-inventory-{env}"
    cd_id = f"{profile_id}/customDomains/cd-{host.replace('.', '-')}"
    token = f"[reference('{cd_id}', '2025-04-15').validationProperties.validationToken]"
    endpoint_host = f"[reference('{endpoint_id}', '2025-04-15').hostName]"

    want = ["Microsoft.Cdn/profiles/originGroups", "Microsoft.Cdn/profiles/originGroups/origins",
            "Microsoft.Cdn/profiles/customDomains", "Microsoft.Cdn/profiles/afdEndpoints/routes"]
    if zone:
        want += ["Microsoft.Network/dnsZones/TXT", "Microsoft.Network/dnsZones/CNAME"]
    check(sorted(r["type"] for r in resources) == sorted(want),
          f"{label}: resource types {sorted(r['type'] for r in resources)}, expected {sorted(want)}")
    # Per-app objects only, in the environment's profile: never the profile, its endpoint, the WAF policy
    # or the environment's own security policy, and nothing that links or names a WAF policy.
    linked = [word for word in FDA_FORBIDDEN if word in json.dumps(resources).lower()]
    check(not linked, f"{label}: the app route links or names {linked} (the environment's WAF policy can't be linked twice)")
    for r in resources:
        if r["type"].startswith("Microsoft.Cdn/"):
            check(r["id"].startswith(f"{profile_id}/") and r["id"] != f"{profile_id}/securityPolicies/secp-contoso-{env}",
                  f"{label}: {r['id']} is not a per-app object of afd-contoso-{env}")

    def one(rtype: str) -> dict:
        found = [r for r in resources if r["type"] == rtype]
        return found[0] if len(found) == 1 else {}

    origin_group = one("Microsoft.Cdn/profiles/originGroups")
    check(origin_group.get("id") == og_id and origin_group.get("properties") == {
              "loadBalancingSettings": {"sampleSize": 4, "successfulSamplesRequired": 3, "additionalLatencyInMilliseconds": 50},
              "sessionAffinityState": "Disabled"},
          f"{label}: origin group {origin_group} (expected {og_id}, no health probe, no session affinity)")
    fqdn = (f"[format('{{0}}.{{1}}', 'ca-hotel-inventory', reference('{rg}/providers/Microsoft.App/managedEnvironments/"
            f"cae-contoso-{exp['mode']}-{env}', '2025-01-01').defaultDomain)]")
    origin = one("Microsoft.Cdn/profiles/originGroups/origins")
    check(origin.get("id") == f"{og_id}/origins/orig-hotel-inventory-{env}" and origin.get("properties") == {
              "hostName": fqdn, "originHostHeader": fqdn, "httpPort": 80, "httpsPort": 443, "priority": 1, "weight": 1000,
              "enabledState": "Enabled", "enforceCertificateNameCheck": True},
          f"{label}: origin {origin} (expected ca-hotel-inventory.<CAE default domain> as host and host header)")
    domain = one("Microsoft.Cdn/profiles/customDomains")
    check(domain.get("id") == cd_id and domain.get("properties") == {
              "hostName": host, "tlsSettings": {"certificateType": "ManagedCertificate", "minimumTlsVersion": "TLS12"},
              "azureDnsZone": None if zone is None else {"id": zone}},
          f"{label}: custom domain {domain} (expected {host}, Front Door-managed certificate, TLS 1.2, zone {zone})")
    route = one("Microsoft.Cdn/profiles/afdEndpoints/routes")
    route_props = route.get("properties", {})
    check(route.get("id") == f"{endpoint_id}/routes/route-hotel-inventory-{env}" and "cacheConfiguration" not in route_props
          and route_props == {
              "customDomains": [{"id": cd_id}] + ([{"id": f"{profile_id}/customDomains/cd-{exp['retained'].replace('.', '-')}"}]
                                                  if exp.get("retained") else []),
              "originGroup": {"id": og_id}, "ruleSets": [],
              "supportedProtocols": ["Http", "Https"], "patternsToMatch": ["/*"], "forwardingProtocol": "HttpsOnly",
              "linkToDefaultDomain": "Disabled", "httpsRedirect": "Enabled", "enabledState": "Enabled"},
          f"{label}: route {route} (expected only the custom domain, not the default domain, HTTPS redirect, "
          f"HTTPS to the origin, no caching)")

    if zone:
        zone_id = f"/subscriptions/{NONPROD_SUB}/resourceGroups/rg-dns/providers/Microsoft.Network/dnsZones/contoso.com"
        txt, cname = one("Microsoft.Network/dnsZones/TXT"), one("Microsoft.Network/dnsZones/CNAME")
        # The platform's mark on its own record sets (ADR-0052).
        mark = {"saf-app": "hotel-inventory", "saf-env": env}
        check(txt.get("id") == f"{zone_id}/TXT/_dnsauth.{exp['record']}"
              and txt.get("properties") == {"TTL": 3600, "metadata": mark, "TXTRecords": [{"value": [token]}]},
              f"{label}: TXT record {txt} (expected _dnsauth.{exp['record']} = the validation token, metadata {mark})")
        check(cname.get("id") == f"{zone_id}/CNAME/{exp['record']}"
              and cname.get("properties") == {"TTL": 3600, "metadata": mark, "CNAMERecord": {"cname": endpoint_host}},
              f"{label}: CNAME record {cname} (expected {exp['record']} -> the endpoint host, metadata {mark})")

    outputs = (data or {}).get("outputs", {})
    check(outputs.get("customDomainId") == cd_id and outputs.get("endpointHostName") == endpoint_host
          and outputs.get("validationToken") == token,
          f"{label}: outputs customDomainId / endpointHostName / validationToken: {outputs}")
    # Provisioning reads the profile's Front Door ID from this record (ADR-0010, amended 2026-11-02).
    check("frontdoorid" in str(outputs.get("frontDoorId")).lower(),
          f"{label}: frontDoorId output {outputs.get('frontDoorId')} (expected the profile's properties.frontDoorId)")
    records = str(outputs.get("dnsRecords"))
    check(f"'writtenToZone', {'true' if zone else 'false'}()" in records and f"'name', '_dnsauth.{host}'" in records
          and f"'name', '{host}'" in records,
          f"{label}: dnsRecords output {records}")


# Portal-side private endpoint of an app vault (infra/app/portal-vault-endpoint.bicep, ADR-0025). The
# example: hotel-inventory's prod vault (externalHybrid), the portal in prod, one subscription.
PVE_EXAMPLE = "app/examples/hotel-inventory-prod.portal-endpoint.bicepparam"
PVE_PORTAL_RG = f"/subscriptions/{PROD_SUB}/resourceGroups/rg-contoso-portal-prod"
PVE_NONPROD_ARGS = ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-portal-prod",
                    "--deployment-name", "pep-portal-hotel-inventory-nonprod"]
PVE_EXPECTED = {"env": "prod", "sub": PROD_SUB, "approval": "automatic", "generation": 0}
PVE_SUB_LINE = "param vaultSubscriptionId = '00000000-0000-0000-0000-00000000b001'"

# (label, text replacements in the example, snapshot arguments or None for the example's, expectation):
# a dict of PVE_EXPECTED overrides, or a message fragment the snapshot must fail with.
PVE_VARIANTS: list[tuple[str, list[tuple[str, str]], list[str] | None, dict | str]] = [
    ("a nonprod vault in another subscription: a manual request",
     [("param environmentName = 'prod'", "param environmentName = 'nonprod'"),
      (PVE_SUB_LINE, "param vaultSubscriptionId = '00000000-0000-0000-0000-00000000a001'")], PVE_NONPROD_ARGS,
     {"env": "nonprod", "sub": NONPROD_SUB, "approval": "manual"}),
    ("External only in the VNet variant",
     [("param networkMode = 'externalHybrid'", "param networkMode = 'externalOnly'"),
      ("param externalOnlyNetwork = 'managed'", "param externalOnlyNetwork = 'vnet'")], None, {}),
    ("subscription ID in upper case",
     [(PVE_SUB_LINE, "param vaultSubscriptionId = '00000000-0000-0000-0000-00000000B001'")], None, {}),
    ("generation 1 names the next vault", [("param generation = 0", "param generation = 1")], None, {"generation": 1}),
    ("a managed-network vault", [("param networkMode = 'externalHybrid'", "param networkMode = 'externalOnly'")], None,
     "hotel-inventory runs on the Azure-managed network in prod"),
    ("another resource group", [], ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-platform-prod",
                                    "--deployment-name", "pep-portal-hotel-inventory-prod"],
     "deploy into the portal resource group rg-contoso-portal-prod"),
    ("another deployment name", [], ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-portal-prod",
                                     "--deployment-name", "pep-kvhotelinventory-portal"],
     "the deployment name must be pep-portal-hotel-inventory-prod"),
    ("the portal of another environment", [("param portalEnvironmentName = 'prod'", "param portalEnvironmentName = 'nonprod'")],
     None, "deploy into the portal resource group rg-contoso-portal-nonprod"),
    ("subscription ID is a GUID", [(PVE_SUB_LINE, "param vaultSubscriptionId = '00000000-0000-0000-0000-00000000b0g1'")], None,
     "vaultSubscriptionId must be a subscription ID"),
    ("environment name", [("param environmentName = 'prod'", "param environmentName = 'Prod'")], None,
     "naming: invalid environment name"),
    ("unknown network mode", [("param networkMode = 'externalHybrid'", "param networkMode = 'internalOnly'")], None,
     "'externalHybrid' | 'externalOnly'"),
    ("location has no default", [("param location = 'westeurope'\n", "")], None,
     'missing an assignment in the params file: "location"'),
]


def lz_vault_name(snaps: dict[str, dict], env: str) -> str | None:
    """The app vault the landing-zone example of env creates (Microsoft.KeyVault/vaults)."""
    data = snaps.get(f"app/examples/hotel-inventory-{env}.lz.bicepparam") or {}
    names = [r.get("name") for r in data.get("predictedResources", []) if r.get("type") == "Microsoft.KeyVault/vaults"]
    return names[0] if len(names) == 1 else None


def check_portal_endpoint(compiled: dict[str, dict], snaps: dict[str, dict]) -> None:
    """infra/app/portal-vault-endpoint.bicep: the compiled template creates only the endpoint and its zone
    group; the example as declared and the variants of PVE_VARIANTS (in parallel, each in its own copy)."""
    template = compiled.get("portal-vault-endpoint.bicep", {})
    resources = template.get("resources", {})
    types = sorted(r.get("type", "") for r in (resources.values() if isinstance(resources, dict) else resources))
    check(types == ["Microsoft.Network/privateEndpoints", "Microsoft.Network/privateEndpoints/privateDnsZoneGroups"],
          f"portal-vault-endpoint.bicep must create exactly the endpoint and its DNS zone group (no nested deployment, "
          f"no role assignment), got {types}")
    vaults = {"prod": lz_vault_name(snaps, "prod"), "nonprod": lz_vault_name(snaps, "nonprod")}
    check(all(vaults.values()), f"portal endpoint: the landing-zone examples must each create one app vault: {vaults}")
    check_portal_endpoint_snapshot(f"portal endpoint {PVE_EXAMPLE}", snaps.get(PVE_EXAMPLE), PVE_EXPECTED, vaults)
    text = (INFRA / PVE_EXAMPLE).read_text()
    with tempfile.TemporaryDirectory(prefix="saf-pve-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")

        def run_variant(i: int) -> tuple[int, str, dict | None]:
            label, replacements, args, _ = PVE_VARIANTS[i]
            case_text = text
            for old, new in replacements:
                if old not in case_text:
                    return 1, f"marker '{old[:60]}' not found in {PVE_EXAMPLE}", None
                case_text = case_text.replace(old, new, 1)
            case = (work / PVE_EXAMPLE).with_name(f"pve-case-{i}.bicepparam")
            case.write_text(case_text)
            try:
                return snapshot(case, args or EXAMPLES[PVE_EXAMPLE])
            finally:
                case.unlink()

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run_variant, range(len(PVE_VARIANTS))))

    for (label, _, _, expected), (rc, log, data) in zip(PVE_VARIANTS, results):
        if isinstance(expected, str):
            check(rc != 0 and expected.lower() in log.lower(), f"portal endpoint '{label}' did not fail with '{expected}':\n{log[:600]}")
            continue
        check(rc == 0 and data is not None and not data.get("diagnostics"), f"portal endpoint '{label}' failed:\n{log[:1500]}")
        if data is not None:
            check_portal_endpoint_snapshot(f"portal endpoint '{label}'", data, {**PVE_EXPECTED, **expected}, vaults)
    print(f"portal endpoint: 1 example, {len(PVE_VARIANTS)} variants")


def check_portal_endpoint_snapshot(label: str, data: dict | None, exp: dict, vaults: dict[str, str | None]) -> None:
    resources = (data or {}).get("predictedResources", [])
    endpoints = [r for r in resources if r.get("type") == "Microsoft.Network/privateEndpoints"]
    groups = [r for r in resources if r.get("type") == "Microsoft.Network/privateEndpoints/privateDnsZoneGroups"]
    if len(endpoints) != 1 or len(groups) != 1 or len(resources) != 2:
        failures.append(f"{label}: expected exactly one private endpoint and its zone group, got "
                        f"{sorted(r.get('type') for r in resources)}")
        return
    env, sub = exp["env"], exp["sub"]
    vault = vaults.get(env) or ""
    outputs = (data or {}).get("outputs", {})
    if exp["generation"] != 0:
        # Another generation names another vault (landing-zone.bicep the same way): same pattern, other hash.
        check(re.fullmatch(r"kvhotelinventory[a-z0-9]{6}", outputs.get("vaultName", "")) is not None
              and outputs.get("vaultName") != vault,
              f"{label}: generation {exp['generation']} must name another vault, got {outputs.get('vaultName')}")
        vault = outputs.get("vaultName", "")
    name = f"pep-{vault}-portal"
    vault_id = f"/subscriptions/{sub}/resourceGroups/rg-contoso-app-hotel-inventory-{env}/providers/Microsoft.KeyVault/vaults/{vault}"
    ep = endpoints[0]
    props = ep.get("properties", {})
    check(ep.get("id") == f"{PVE_PORTAL_RG}/providers/Microsoft.Network/privateEndpoints/{name}",
          f"{label}: endpoint {ep.get('id')} must be {name} in rg-contoso-portal-prod (the vault the landing zone names)")
    check(ep.get("location") == "westeurope", f"{label}: endpoint location {ep.get('location')}")
    check(ep.get("tags") == {"Application": "hotel-inventory", "Environment": env, "ManagedBy": "SAF"},
          f"{label}: endpoint tags {ep.get('tags')}")
    check(props.get("subnet") == {"id": f"{PVE_PORTAL_RG}/providers/Microsoft.Network/virtualNetworks/vnet-contoso-portal-prod/"
                                         "subnets/snet-contoso-pep-portal-prod"},
          f"{label}: the endpoint must be in the portal VNet's private-endpoint subnet, got {props.get('subnet')}")
    check(props.get("customNetworkInterfaceName") == f"nic-{name}", f"{label}: NIC {props.get('customNetworkInterfaceName')}")
    auto, manual = props.get("privateLinkServiceConnections"), props.get("manualPrivateLinkServiceConnections")
    used, unused = (auto, manual) if exp["approval"] == "automatic" else (manual, auto)
    check(unused == [] and isinstance(used, list) and len(used) == 1,
          f"{label}: exactly one {exp['approval']} connection (automatic {auto}, manual {manual})")
    if isinstance(used, list) and len(used) == 1:
        conn = used[0].get("properties", {})
        check(used[0].get("name") == name and conn.get("privateLinkServiceId") == vault_id and conn.get("groupIds") == ["vault"],
              f"{label}: the connection must target {vault_id} (group vault), got {used[0]}")
    zone = f"{PVE_PORTAL_RG}/providers/Microsoft.Network/privateDnsZones/privatelink.vaultcore.azure.net"
    check(groups[0].get("name") == f"{name}/default"
          and groups[0].get("properties", {}).get("privateDnsZoneConfigs") == [{"name": "vault", "properties": {"privateDnsZoneId": zone}}],
          f"{label}: the zone group must register only in the portal's privatelink.vaultcore.azure.net, got {groups[0]}")
    check(outputs.get("approval") == exp["approval"] and outputs.get("vaultName") == vault and outputs.get("vaultId") == vault_id
          and outputs.get("endpointName") == name, f"{label}: outputs {outputs}")


def check_portal_readers(snaps: dict[str, dict]) -> None:
    """environment.bicep (ADR-0026, ADR-0017, ADR-0010): each environment example gives the portal
    identity exactly three roles, Log Analytics Reader on its workspace, Cost Management Reader on its
    subscription and Reader on its managed Front Door profile (both examples have one), each once and
    nothing else; with portalIdentityPrincipalId '' none exists."""
    for rel, (env, _variants) in ENVIRONMENT_EXAMPLES.items():
        text = (INFRA / rel).read_text()
        m = re.search(r"^param portalIdentityPrincipalId = '([^']*)'$", text, re.M)
        check(m is not None and m.group(1) != "", f"{rel}: portalIdentityPrincipalId not found or empty")
        if m is None or m.group(1) == "":
            continue
        principal = m.group(1)
        resources = (snaps.get(rel) or {}).get("predictedResources", [])
        check(bool(resources), f"{rel}: no predicted resources")
        if not resources:
            continue
        sub = resources[0]["id"].split("/resourceGroups/")[0]
        check(re.fullmatch(r"/subscriptions/[0-9a-f-]{36}", sub) is not None, f"{rel}: subscription scope not found ({sub})")
        workspace = f"{sub}/resourceGroups/rg-contoso-platform-{env}/providers/Microsoft.OperationalInsights/workspaces/log-contoso-{env}"
        profile = f"{sub}/resourceGroups/rg-contoso-platform-{env}/providers/Microsoft.Cdn/profiles/afd-contoso-{env}"
        expected = {ROLE_LOG_ANALYTICS_READER: ("Log Analytics Reader", workspace), ROLE_COST_MANAGEMENT_READER: ("Cost Management Reader", sub),
                    ROLE_READER: ("Reader on the Front Door profile", profile)}
        assignments = [r for r in resources if r.get("type") == "Microsoft.Authorization/roleAssignments"]
        for role, (label, scope) in expected.items():
            found = [a for a in assignments if role_guid(a) == role]
            check(len(found) == 1 and found[0]["id"].split("/providers/Microsoft.Authorization/roleAssignments/")[0] == scope,
                  f"{rel}: {label} at {[a['id'] for a in found]}, expected exactly once at {scope}")
            for a in found:
                props = a.get("properties", {})
                check(props.get("principalId") == principal and props.get("principalType") == "ServicePrincipal"
                      and "condition" not in props and bool(props.get("description")),
                      f"{rel}: {label} to {props.get('principalId')}, expected the portal identity {principal}")
        held = sorted(role_guid(a) for a in assignments if str(a.get("properties", {}).get("principalId")).lower() == principal.lower())
        check(held == sorted(PORTAL_ENVIRONMENT_ROLES | {ROLE_READER}),
              f"{rel}: the portal identity holds {held}, expected exactly {sorted(PORTAL_ENVIRONMENT_ROLES | {ROLE_READER})}")
        with tempfile.TemporaryDirectory(prefix="saf-portal-readers-") as tmp:
            work = Path(tmp) / "infra"
            shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
            shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
            case = (work / rel).with_name("no-portal-case.bicepparam")
            case.write_text(text.replace(m.group(0), "param portalIdentityPrincipalId = ''"))
            rc, log, data = snapshot(case, EXAMPLES[rel])
            check(rc == 0 and data is not None, f"{rel} without portal identity failed:\n{log[:1500]}")
            none = [r for r in (data or {}).get("predictedResources", []) if r.get("type") == "Microsoft.Authorization/roleAssignments"
                    and (role_guid(r) in PORTAL_ENVIRONMENT_ROLES or "/providers/Microsoft.Cdn/profiles/" in r.get("id", ""))]
            check(not none, f"{rel} without portal identity: portal roles assigned {none}")
    print(f"portal readers: {len(ENVIRONMENT_EXAMPLES)} environment examples, with and without the portal identity")


def check_portal(snaps: dict[str, dict]) -> None:
    """portal.bicep (ADR-0036, ADR-0025): pass 1 = the example without SAF_PORTAL_IMAGE_DIGEST,
    pass 2 = the same file with digest and client ID; pass-2 inputs that must fail."""
    allowed = platform_role_set(snaps)
    param_file = INFRA / PORTAL_EXAMPLE
    args = EXAMPLES[PORTAL_EXAMPLE]

    def portal_env(digest: str | None, client_id: str | None) -> dict[str, str]:
        env = with_env("SAF_PORTAL_IMAGE_DIGEST", digest)
        if client_id is not None:
            env["SAF_PORTAL_CLIENT_ID"] = client_id
        return env

    vaults = portal_environment_vaults(snaps)
    private = vaults.get("private") or ""
    check_portal_snapshot("portal pass 1", snaps.get(PORTAL_EXAMPLE), False, allowed, private)
    rc, log, data = snapshot(param_file, args, portal_env(PORTAL_DIGEST, PORTAL_CLIENT_ID))
    check(rc == 0 and data is not None and not (data or {}).get("diagnostics"), f"portal pass 2 failed:\n{log[:1500]}")
    check_portal_snapshot("portal pass 2", data, True, allowed, private)
    # Pass 1 with the client ID already known is pass 1 all the same.
    rc, log, data = snapshot(param_file, args, portal_env(None, PORTAL_CLIENT_ID))
    check(rc == 0 and data is not None, f"portal pass 1 with client ID failed:\n{log[:1500]}")
    check_portal_snapshot("portal pass 1 (client ID known)", data, False, allowed, private)

    # ADR-0025 amendment 2026-11-14, US10.18: the environment vault of the portal's own secrets and the
    # SMTP password secret, through the pipeline's parameter file (the inputs of `portal-inputs`).
    pipeline_param = PLATFORM_PIPELINE / "portal.bicepparam"
    base = json.loads((PLATFORM_PIPELINE / "examples" / "contoso-prod.portal.json").read_text())
    smtp = {"smtpPasswordSecretName": "smtp-password", "smtpPasswordSecretExists": True}
    variants = [
        # (label, input changes, pass 2, environment vault, its endpoint, secret with the role)
        ("SMTP secret present", smtp, True, private, True, "smtp-password"),
        ("SMTP secret present, pass 1", dict(smtp, portalImageDigest="", portalClientId=""), False, private, True, "smtp-password"),
        ("SMTP secret absent", dict(smtp, smtpPasswordSecretExists=False), True, private, True, None),
        ("public vault, SMTP secret present", dict(smtp, environmentVault="public"), True, vaults.get("public") or "", False, "smtp-password"),
        ("public vault, no SMTP", {"environmentVault": "public"}, True, vaults.get("public") or "", False, None),
    ]
    for label, change, pass2, vault, endpoint, secret in variants:
        rc, log, data = snapshot(pipeline_param, ["--subscription-id", PROD_SUB], with_env("SAF_PORTAL_JSON", json.dumps(dict(base, **change))))
        check(rc == 0 and data is not None and not (data or {}).get("diagnostics"), f"portal {label} failed:\n{log[:1500]}")
        check_portal_snapshot(f"portal {label}", data, pass2, allowed, vault, endpoint, secret)
    vault_negative = [
        ("secret exists without a name", {"smtpPasswordSecretExists": True}, "smtpPasswordSecretExists needs smtpPasswordSecretName"),
        ("secret name with an underscore", {"smtpPasswordSecretName": "smtp_password"},
         "smtpPasswordSecretName must be empty or a Key Vault secret name"),
        ("secret name too long", {"smtpPasswordSecretName": "a" * 128}, "smtpPasswordSecretName must be empty or a Key Vault secret name"),
        ("unknown vault variant", {"environmentVault": "shared"}, "'private' | 'public'"),
        ("vault generation below 0", {"vaultGeneration": -1}, "minimum allowable value is 0"),
    ]
    for label, change, fragment in vault_negative:
        rc, log, _ = snapshot(pipeline_param, ["--subscription-id", PROD_SUB], with_env("SAF_PORTAL_JSON", json.dumps(dict(base, **change))))
        check(rc != 0 and fragment.lower() in log.lower(), f"portal negative '{label}' did not fail with '{fragment}':\n{log[:600]}")

    # ADR-0071: the portal's own host name, through the pipeline's parameter file.
    zone = PORTAL_ZONE_ID.format(sub=PROD_SUB)
    no_host = {"hostName": "", "dnsZoneId": "", "backendIpRanges": []}
    fd_variants = [
        # (label, frontDoor input, pass 2)
        ("without a host name", no_host, True),
        ("without a host name, pass 1", no_host, False),
        ("host name in an Azure DNS zone", dict(PORTAL_FRONT_DOOR, dnsZoneId=zone), True),
        ("host name, pass 1 before the ranges", dict(PORTAL_FRONT_DOOR, backendIpRanges=[]), False),
    ]
    for label, fd, pass2 in fd_variants:
        change = {"frontDoor": fd} if pass2 else {"frontDoor": fd, "portalImageDigest": "", "portalClientId": ""}
        rc, log, data = snapshot(pipeline_param, ["--subscription-id", PROD_SUB], with_env("SAF_PORTAL_JSON", json.dumps(dict(base, **change))))
        check(rc == 0 and data is not None and not (data or {}).get("diagnostics"), f"portal {label} failed:\n{log[:1500]}")
        check_portal_snapshot(f"portal {label}", data, pass2, allowed, private, front_door=fd)
    fd_negative = [
        ("host name with upper case", dict(PORTAL_FRONT_DOOR, hostName="Portal.contoso.com"), "must be '' or a lowercase host name"),
        ("host name with two labels", dict(PORTAL_FRONT_DOOR, hostName="contoso.com"), "must be '' or a lowercase host name"),
        ("zone in another subscription", dict(PORTAL_FRONT_DOOR, dnsZoneId=PORTAL_ZONE_ID.format(sub=NONPROD_SUB)),
         "is in subscription"),
        ("host name not below the zone", dict(PORTAL_FRONT_DOOR, hostName="portal.contoso.eu", dnsZoneId=zone), "is not below the DNS zone"),
        ("zone that is not a public zone", dict(PORTAL_FRONT_DOOR, dnsZoneId=zone.replace("dnszones", "privateDnsZones")),
         "must be '' or the resource ID of a public Azure DNS zone"),
        ("pass 2 without the ranges", dict(PORTAL_FRONT_DOOR, backendIpRanges=[]), "must list the AzureFrontDoor.Backend IPv4 ranges"),
        ("ranges without a host name", dict(no_host, backendIpRanges=["192.0.2.0/24"]), "need a frontDoor.hostName"),
    ]
    for label, fd, fragment in fd_negative:
        rc, log, _ = snapshot(pipeline_param, ["--subscription-id", PROD_SUB], with_env("SAF_PORTAL_JSON", json.dumps(dict(base, frontDoor=fd))))
        check(rc != 0 and fragment.lower() in log.lower(), f"portal negative '{label}' did not fail with '{fragment}':\n{log[:600]}")

    negative = [
        ("pass 2 without client ID", PORTAL_DIGEST, None,
         "portalClientId must be the client ID (a GUID) of the portal's Entra app registration when portalImageDigest is set"),
        ("pass 2 client ID not a GUID", PORTAL_DIGEST, "ca-contoso-portal",
         "portalClientId must be the client ID (a GUID) of the portal's Entra app registration when portalImageDigest is set"),
        ("digest is a tag", "latest", PORTAL_CLIENT_ID, "portalImageDigest must be empty (pass 1) or sha256:<64 lowercase hex>"),
        ("digest upper-case hex", "sha256:" + "0123456789ABCDEF" * 4, PORTAL_CLIENT_ID,
         "portalImageDigest must be empty (pass 1) or sha256:<64 lowercase hex>"),
        ("pass 1 client ID not a GUID", None, "not-a-guid", "portalClientId must be empty or the client ID (a GUID)"),
    ]
    for label, digest, client_id, fragment in negative:
        rc, log, _ = snapshot(param_file, args, portal_env(digest, client_id))
        check(rc != 0 and fragment.lower() in log.lower(), f"portal negative '{label}' did not fail with '{fragment}':\n{log[:600]}")
    print(f"portal: pass 1, pass 1 with client ID, pass 2, {len(variants)} vault and SMTP variants, "
          f"{len(fd_variants)} host name variants, {len(negative) + len(vault_negative) + len(fd_negative)} negative")


def portal_environment_vaults(snaps: dict[str, dict]) -> dict[str, str]:
    """The portal host prod's environment vault names: platform-names.bicep (as the pipeline reads them), the
    private one checked against the prod environment example's vault (environment.bicep names it)."""
    names_input = {"prefix": "contoso", "environmentName": "prod", "modes": ["externalOnly", "externalHybrid"], "vaultGeneration": 0}
    rc, log, names = snapshot(PLATFORM_PIPELINE / "platform-names.bicepparam", ["--subscription-id", PROD_SUB],
                              with_env("SAF_PLATFORM_NAMES_JSON", json.dumps(names_input)))
    out = (names or {}).get("outputs", {})
    vaults = {"private": str(out.get("environmentVaultPrivate") or ""), "public": str(out.get("environmentVaultPublic") or "")}
    check(rc == 0 and re.fullmatch(r"kvcontosoprodn[a-z0-9]{5}", vaults["private"]) is not None
          and re.fullmatch(r"kvcontosoprodp[a-z0-9]{5}", vaults["public"]) is not None,
          f"platform names.bicep environment vaults of prod: {vaults}\n{log[:600]}")
    example = [r.get("name") for r in (snaps.get("platform/examples/contoso-prod.bicepparam") or {}).get("predictedResources", [])
               if r.get("type") == "Microsoft.KeyVault/vaults"]
    check(example == [vaults["private"]], f"portal: the prod environment example's vaults {example} must be the private vault "
                                          f"{vaults['private']} platform-names.bicep names (portal.bicep names it the same way)")
    return vaults


def check_portal_snapshot(label: str, data: dict | None, pass2: bool, allowed: set[str], vault: str,
                          vault_endpoint: bool = True, smtp_secret: str | None = None,
                          front_door: dict | None = None) -> None:
    """One portal snapshot. vault: the host's environment vault of the portal's own secrets (ADR-0025);
    vault_endpoint: it is the private one, with the portal-side endpoint; smtp_secret: the SMTP password
    secret the portal identity reads (Key Vault Secrets User on it, SAF_SMTP_PASSWORD_VAULT_URI), or None;
    front_door: the input frontDoor (ADR-0071), PORTAL_FRONT_DOOR by default."""
    front_door = PORTAL_FRONT_DOOR if front_door is None else front_door
    host = front_door.get("hostName") or ""
    zone_id = front_door.get("dnsZoneId") or ""
    resources = (data or {}).get("predictedResources", [])
    if not resources:
        failures.append(f"{label}: no predicted resources")
        return
    sub = f"/subscriptions/{PROD_SUB}"
    rg = f"{sub}/resourceGroups/rg-contoso-portal-prod"
    platform_rg = f"{sub}/resourceGroups/rg-contoso-platform-prod"
    identity = f"{sub}/resourceGroups/rg-contoso-identities-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-contoso-portal"
    vnet_id = f"{rg}/providers/Microsoft.Network/virtualNetworks/vnet-contoso-portal-prod"

    def of_type(t: str) -> list[dict]:
        return [r for r in resources if r.get("type") == t]

    # Exactly this resource set, all in the portal RG except the one role assignment.
    want_counts = {
        "Microsoft.Resources/resourceGroups": 1, "Microsoft.Network/networkSecurityGroups": 2,
        "Microsoft.Insights/diagnosticSettings": 4, "Microsoft.Network/publicIPAddresses": 1,
        "Microsoft.Network/natGateways": 1, "Microsoft.Network/virtualNetworks": 1, "Microsoft.Network/privateDnsZones": 2,
        "Microsoft.Network/privateDnsZones/virtualNetworkLinks": 2, "Microsoft.App/managedEnvironments": 1,
        "Microsoft.Authorization/roleAssignments": 2 if smtp_secret else 1,
        "Microsoft.Sql/servers": 1, "Microsoft.Sql/servers/azureADOnlyAuthentications": 1, "Microsoft.Sql/servers/databases": 1,
        "Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies": 1, "Microsoft.Sql/servers/auditingSettings": 1,
        "Microsoft.Network/privateEndpoints": 2 if vault_endpoint else 1,
        "Microsoft.Network/privateEndpoints/privateDnsZoneGroups": 2 if vault_endpoint else 1,
        **({"Microsoft.App/containerApps": 1} if pass2 else {}),
        # The portal's own host name in the host's Front Door profile, every pass (ADR-0071).
        **({"Microsoft.Cdn/profiles/originGroups": 1, "Microsoft.Cdn/profiles/originGroups/origins": 1,
            "Microsoft.Cdn/profiles/customDomains": 1, "Microsoft.Cdn/profiles/afdEndpoints/routes": 1} if host else {}),
        **({"Microsoft.Network/dnsZones/TXT": 1, "Microsoft.Network/dnsZones/CNAME": 1} if zone_id else {}),
    }
    got_counts: dict[str, int] = {}
    for r in resources:
        got_counts[r.get("type", "")] = got_counts.get(r.get("type", ""), 0) + 1
    check(got_counts == want_counts, f"{label}: resources {got_counts}, expected {want_counts}")
    check([r["id"] for r in of_type("Microsoft.Resources/resourceGroups")] == [rg], f"{label}: resource group is not {rg}")
    # The sql zone is named from environment().suffixes (evaluated at deployment), so its ID and its
    # link's are expressions; they must still be built in the portal RG.
    profile_id = f"{platform_rg}/providers/Microsoft.Cdn/profiles/afd-contoso-prod"
    zone_rg = "/".join(zone_id.split("/")[:5]) if zone_id else ""
    outside = [r["id"] for r in resources if r.get("type") not in ("Microsoft.Resources/resourceGroups", "Microsoft.Authorization/roleAssignments")
               and not r["id"].startswith(rg + "/")
               and not (r["id"].startswith("[resourceId(") and f"'{PROD_SUB}', 'rg-contoso-portal-prod', " in r["id"])
               and not (host and r.get("type", "").startswith("Microsoft.Cdn/") and r["id"].startswith(profile_id + "/"))
               and not (zone_id and r.get("type", "").startswith("Microsoft.Network/dnsZones/")
                        and r["id"].lower().startswith(f"{zone_rg}/providers/Microsoft.Network/dnsZones/contoso.com/".lower()))]
    check(not outside, f"{label}: resources outside {rg} (and the Front Door profile and DNS zone with a host name): {outside}")
    if host:
        check_portal_front_door(label, resources, host, zone_id)
    names = {r.get("type"): sorted(x["name"] for x in of_type(r.get("type"))) for r in resources}
    for t, want in (("Microsoft.Network/networkSecurityGroups", ["nsg-contoso-cae-portal-prod", "nsg-contoso-pep-portal-prod"]),
                    ("Microsoft.Network/natGateways", ["ng-contoso-portal-prod"]),
                    ("Microsoft.Network/publicIPAddresses", ["pip-contoso-ng-portal-prod-01"]),
                    ("Microsoft.Network/virtualNetworks", ["vnet-contoso-portal-prod"]),
                    ("Microsoft.App/managedEnvironments", ["cae-contoso-portal-prod"])):
        check(names.get(t) == want, f"{label}: {t} names {names.get(t)}, expected {want}")

    # VNet: peered to nothing, Azure DNS; the CAE subnet egresses through the portal NAT Gateway
    # (no route table), the private-endpoint subnet has neither.
    vnets = of_type("Microsoft.Network/virtualNetworks")
    vprops = vnets[0].get("properties", {}) if vnets else {}
    check(vprops.get("virtualNetworkPeerings") == [] and vprops.get("dhcpOptions", {}).get("dnsServers") == [],
          f"{label}: portal VNet must be peered to nothing with Azure DNS: {vprops.get('virtualNetworkPeerings')}")
    subnets = {s.get("name"): s.get("properties", {}) for s in vprops.get("subnets", [])}
    cae_subnet, pep_subnet = subnets.get("snet-contoso-cae-portal-prod", {}), subnets.get("snet-contoso-pep-portal-prod", {})
    check(sorted(subnets) == ["snet-contoso-cae-portal-prod", "snet-contoso-pep-portal-prod"], f"{label}: subnets {sorted(subnets)}")
    check((cae_subnet.get("natGateway") or {}).get("id") == f"{rg}/providers/Microsoft.Network/natGateways/ng-contoso-portal-prod"
          and cae_subnet.get("routeTable") is None
          and [d.get("properties", {}).get("serviceName") for d in cae_subnet.get("delegations", [])] == ["Microsoft.App/environments"]
          and (cae_subnet.get("networkSecurityGroup") or {}).get("id") == f"{rg}/providers/Microsoft.Network/networkSecurityGroups/nsg-contoso-cae-portal-prod",
          f"{label}: CAE subnet must use the portal NAT Gateway and NSG, no route table: {cae_subnet}")
    check(not pep_subnet.get("natGateway") and not pep_subnet.get("routeTable")
          and (pep_subnet.get("networkSecurityGroup") or {}).get("id") == f"{rg}/providers/Microsoft.Network/networkSecurityGroups/nsg-contoso-pep-portal-prod",
          f"{label}: private-endpoint subnet {pep_subnet}")

    # The portal's own vault and sql zones, in the portal RG, each linked to the portal VNet only. The sql
    # zone's name is privatelink + environment().suffixes.sqlServerHostname (privatelink.database.windows.net
    # in the public cloud), which the snapshot leaves as an expression.
    sql_zone = "format('privatelink{0}', environment().suffixes.sqlServerHostname)"
    vault_zone_id = f"{rg}/providers/Microsoft.Network/privateDnsZones/privatelink.vaultcore.azure.net"
    sql_zone_id = f"[resourceId('{PROD_SUB}', 'rg-contoso-portal-prod', 'Microsoft.Network/privateDnsZones', {sql_zone})]"
    zones = of_type("Microsoft.Network/privateDnsZones")
    links = of_type("Microsoft.Network/privateDnsZones/virtualNetworkLinks")
    check(sorted(z["id"] for z in zones) == sorted([vault_zone_id, sql_zone_id]),
          f"{label}: private DNS zones {[z['id'] for z in zones]}, expected only the portal's vault and sql zones")
    link_ids = sorted(l["id"] for l in links)
    check(len(links) == 2 and link_ids[0].startswith(f"/subscriptions/{PROD_SUB}") is not link_ids[1].startswith(f"/subscriptions/{PROD_SUB}")
          and f"{vault_zone_id}/virtualNetworkLinks/link-vnet-contoso-portal-prod" in link_ids
          and any(sql_zone in i and "'link-vnet-contoso-portal-prod'" in i and "'rg-contoso-portal-prod'" in i for i in link_ids)
          and all(l.get("properties", {}).get("virtualNetwork", {}).get("id") == vnet_id
                  and l.get("properties", {}).get("registrationEnabled") is False for l in links),
          f"{label}: each zone must be linked to the portal VNet only: {links}")

    # CAE in the CAE subnet, external, in the template's location.
    caes = of_type("Microsoft.App/managedEnvironments")
    cprops = caes[0].get("properties", {}) if caes else {}
    check(cprops.get("vnetConfiguration") == {"infrastructureSubnetId": f"{vnet_id}/subnets/snet-contoso-cae-portal-prod", "internal": False},
          f"{label}: CAE vnetConfiguration {cprops.get('vnetConfiguration')}")
    location = caes[0].get("location") if caes else None

    # Portal database (ADR-0070): Azure SQL, Entra-only, private, the portal identity its only administrator.
    servers = of_type("Microsoft.Sql/servers")
    server = servers[0] if servers else {}
    sprops = server.get("properties", {})
    server_name = str(server.get("name"))
    check(re.fullmatch(r"sql-contoso-portal-prod-[a-z0-9]{6}", server_name) is not None and server.get("location") == location,
          f"{label}: Azure SQL server {server_name} in {server.get('location')}, expected sql-contoso-portal-prod-<h6> in {location}")
    check(sprops.get("administrators") == {"administratorType": "ActiveDirectory", "principalType": "Application",
                                           "login": "id-contoso-portal", "sid": f"[reference('{identity}', '2024-11-30').clientId]",
                                           "tenantId": TENANT, "azureADOnlyAuthentication": True}
          and not any(k in sprops for k in ("administratorLogin", "administratorLoginPassword")),
          f"{label}: Azure SQL administrators {sprops.get('administrators')}, expected only id-contoso-portal (sid = its client ID), Entra-only")
    check(sprops.get("publicNetworkAccess") == "Disabled" and sprops.get("minimalTlsVersion") == "1.2",
          f"{label}: Azure SQL network/TLS {sprops.get('publicNetworkAccess')} {sprops.get('minimalTlsVersion')}")
    only = [r.get("properties") for r in of_type("Microsoft.Sql/servers/azureADOnlyAuthentications")]
    check(only == [{"azureADOnlyAuthentication": True}], f"{label}: azureADOnlyAuthentications {only}")
    dbs = of_type("Microsoft.Sql/servers/databases")
    check([d["name"] for d in dbs] == [f"{server_name}/portal"], f"{label}: databases {[d['name'] for d in dbs]}, expected {server_name}/portal")
    db = dbs[0] if dbs else {}
    check(db.get("sku") == {"name": "S0", "tier": "Standard"} and db.get("location") == location
          and db.get("properties") == {"maxSizeBytes": 250 * 1024 ** 3, "requestedBackupStorageRedundancy": "Geo", "zoneRedundant": False},
          f"{label}: Azure SQL database {db.get('sku')} {db.get('properties')}, expected the example's S0, 250 GB, Geo")
    pitr = [r.get("properties") for r in of_type("Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies")]
    check(pitr == [{"retentionDays": 35}], f"{label}: PITR retention {pitr}, expected 35 days")
    audit = [r.get("properties") for r in of_type("Microsoft.Sql/servers/auditingSettings")]
    check(audit == [{"state": "Enabled", "isAzureMonitorTargetEnabled": True}], f"{label}: Azure SQL auditing {audit}")
    check(not of_type("Microsoft.Sql/servers/firewallRules"), f"{label}: the portal's Azure SQL server must have no firewall rule")
    server_id = f"{rg}/providers/Microsoft.Sql/servers/{server_name}"
    peps = {r["id"]: r for r in of_type("Microsoft.Network/privateEndpoints")}
    pep = peps.get(f"{rg}/providers/Microsoft.Network/privateEndpoints/pep-{server_name}", {})
    check(pep.get("properties", {}).get("subnet", {}).get("id") == f"{vnet_id}/subnets/snet-contoso-pep-portal-prod"
          and [(c.get("properties", {}).get("privateLinkServiceId"), c.get("properties", {}).get("groupIds"))
               for c in pep.get("properties", {}).get("privateLinkServiceConnections", [])] == [(server_id, ["sqlServer"])],
          f"{label}: private endpoints {sorted(peps)}: pep-{{server}} in the portal's private-endpoint subnet, for the server")
    # ADR-0025 amendment 2026-11-14: the private environment vault's portal-side endpoint, automatic
    # connection (same subscription), in the portal's private-endpoint subnet and vault zone.
    vault_id = f"{platform_rg}/providers/Microsoft.KeyVault/vaults/{vault}"
    vault_pep_id = f"{rg}/providers/Microsoft.Network/privateEndpoints/pep-{vault}-portal"
    if vault_endpoint:
        vpep = peps.get(vault_pep_id, {})
        vprops_pep = vpep.get("properties", {})
        check(vprops_pep.get("subnet", {}).get("id") == f"{vnet_id}/subnets/snet-contoso-pep-portal-prod"
              and vprops_pep.get("customNetworkInterfaceName") == f"nic-pep-{vault}-portal"
              and [(c.get("properties", {}).get("privateLinkServiceId"), c.get("properties", {}).get("groupIds"))
                   for c in vprops_pep.get("privateLinkServiceConnections", [])] == [(vault_id, ["vault"])]
              and not vprops_pep.get("manualPrivateLinkServiceConnections") and vpep.get("location") == location,
              f"{label}: private endpoints {sorted(peps)}: {vault_pep_id} in the portal's private-endpoint subnet, an automatic "
              f"connection to {vault_id}")
    else:
        check(vault_pep_id not in peps and not any("/pep-kv" in i for i in peps),
              f"{label}: the public environment vault gets no portal-side endpoint: {sorted(peps)}")
    groups = {g["id"].split("/privateDnsZoneGroups/")[0]: [z.get("properties", {}).get("privateDnsZoneId")
                                                            for z in g.get("properties", {}).get("privateDnsZoneConfigs", [])]
              for g in of_type("Microsoft.Network/privateEndpoints/privateDnsZoneGroups")}
    want_groups = {pep.get("id", "?"): [sql_zone_id], **({vault_pep_id: [vault_zone_id]} if vault_endpoint else {})}
    check(groups == want_groups, f"{label}: each endpoint's zone group registers in the portal's own zone of its service only: {groups}")
    # The server's audit goes to the environment workspace through the master database's diagnostic setting.
    server_diag = [r for r in of_type("Microsoft.Insights/diagnosticSettings") if r["id"].startswith(server_id + "/databases/master/")]
    check(len(server_diag) == 1 and server_diag[0].get("properties", {}) == {
              "workspaceId": f"/subscriptions/{PROD_SUB}/resourceGroups/rg-contoso-platform-prod/providers/Microsoft.OperationalInsights/workspaces/log-contoso-prod",
              "logs": [{"category": "SQLSecurityAuditEvents", "enabled": True}]},
          f"{label}: Azure SQL audit diagnostics {server_diag}")

    # Repository Reader for the portal identity at the platform registry; with the SMTP secret, Key Vault
    # Secrets User on that one secret (US10.18), nothing wider.
    secret_scope = f"{vault_id}/secrets/{smtp_secret}/providers/Microsoft.Authorization/roleAssignments/"
    on_secret = [a for a in of_type("Microsoft.Authorization/roleAssignments") if smtp_secret and a["id"].startswith(secret_scope)]
    check(len(on_secret) == (1 if smtp_secret else 0), f"{label}: role assignments on the SMTP secret {[a['id'] for a in on_secret]}")
    for a in on_secret:
        props = a.get("properties", {})
        check(GUID.fullmatch(a["id"][len(secret_scope):]) is not None and role_guid(a) == ROLE_KEY_VAULT_SECRETS_USER
              and role_guid(a) in allowed, f"{label}: role on the SMTP secret {role_guid(a)}, expected Key Vault Secrets User")
        check(f"reference('{identity}'" in str(props.get("principalId")) and str(props.get("principalId")).endswith(".principalId]")
              and props.get("principalType") == "ServicePrincipal" and "condition" not in props and bool(props.get("description")),
              f"{label}: SMTP secret role principal {props.get('principalId')}, expected id-contoso-portal")
    for a in of_type("Microsoft.Authorization/roleAssignments"):
        if a in on_secret:
            continue
        props = a.get("properties", {})
        check(re.fullmatch(rf"{re.escape(platform_rg)}/providers/Microsoft\.ContainerRegistry/registries/crcontosoprod[a-z0-9]{{6}}"
                           rf"/providers/Microsoft\.Authorization/roleAssignments/{GUID.pattern}", a["id"]) is not None,
              f"{label}: role assignment {a['id']} is not at the platform registry")
        check(role_guid(a) == ROLE_REPOSITORY_READER and role_guid(a) in allowed,
              f"{label}: role {role_guid(a)}, expected Container Registry Repository Reader")
        check(f"reference('{identity}'" in str(props.get("principalId")) and str(props.get("principalId")).endswith(".principalId]")
              and props.get("principalType") == "ServicePrincipal" and "condition" not in props and bool(props.get("description")),
              f"{label}: Repository Reader principal {props.get('principalId')}, expected id-contoso-portal")

    outputs = (data or {}).get("outputs", {})
    check(outputs.get("portalResourceGroupName") == "rg-contoso-portal-prod", f"{label}: portalResourceGroupName {outputs.get('portalResourceGroupName')}")
    check(re.fullmatch(r"\[format\('\{0\}\.\{1\}', 'ca-contoso-portal', reference\(.*'cae-.*\)\.outputs\.defaultDomain\.value\)\]",
                       str(outputs.get("portalFqdn"))) is not None,
          f"{label}: portalFqdn {outputs.get('portalFqdn')}, expected ca-contoso-portal.<CAE defaultDomain>")
    check("outputs.publicIpAddresses.value" in str(outputs.get("egressIps")), f"{label}: egressIps {outputs.get('egressIps')}")
    # ADR-0071: the public host name and URL (instance.yaml portal.apiBaseUrl), the Front Door object.
    if host:
        check(outputs.get("portalHostName") == host and outputs.get("portalUrl") == f"https://{host}",
              f"{label}: portalHostName {outputs.get('portalHostName')} / portalUrl {outputs.get('portalUrl')}, expected {host}")
        fd_out = str(outputs.get("frontDoor"))
        check(f"'hostName', '{host}'" in fd_out and "endpointHostName" in fd_out and "dnsRecords" in fd_out,
              f"{label}: frontDoor output {outputs.get('frontDoor')}")
    else:
        check("'ca-contoso-portal'" in str(outputs.get("portalHostName")) and str(outputs.get("portalUrl")).startswith("[format('https://{0}'")
              and outputs.get("frontDoor") is None,
              f"{label}: without a host name portalHostName {outputs.get('portalHostName')} / portalUrl {outputs.get('portalUrl')} "
              f"must be the Container App's address and frontDoor null: {outputs.get('frontDoor')}")
    check((outputs.get("containerApp") is None) != pass2, f"{label}: containerApp output {outputs.get('containerApp')}")
    check("'databaseName', 'portal', 'user', 'id-contoso-portal'" in str(outputs.get("database"))
          and ".outputs.fqdn.value" in str(outputs.get("database")), f"{label}: database output {outputs.get('database')}")
    want_vault_output = {"name": vault, "variant": "private" if vault_endpoint else "public",
                         "portalEndpointName": f"pep-{vault}-portal" if vault_endpoint else None, "smtpPasswordRole": bool(smtp_secret)}
    got_vault_output = outputs.get("environmentVault")
    check(isinstance(got_vault_output, dict) and {k: got_vault_output.get(k) for k in want_vault_output} == want_vault_output,
          f"{label}: environmentVault output {got_vault_output}, expected {want_vault_output}")

    apps = of_type("Microsoft.App/containerApps")
    if not pass2 or not apps:
        return
    app = apps[0]
    props = app.get("properties", {})
    cfg = props.get("configuration", {})
    check(app["id"] == f"{rg}/providers/Microsoft.App/containerApps/ca-contoso-portal" and app.get("location") == location,
          f"{label}: Container App {app['id']} in {app.get('location')}, expected ca-contoso-portal in the CAE's region {location}")
    check(app.get("identity") == {"type": "UserAssigned", "userAssignedIdentities": {identity: {}}},
          f"{label}: Container App identities {app.get('identity')}, expected only id-contoso-portal")
    check("'cae-" in str(props.get("environmentId")) and str(props.get("environmentId")).endswith(".outputs.id.value]")
          and props.get("workloadProfileName") == "Consumption",
          f"{label}: environmentId {props.get('environmentId')} is not the portal CAE")
    ingress = cfg.get("ingress", {})
    check(ingress.get("external") is True and ingress.get("targetPort") == 8080 and ingress.get("allowInsecure") is False
          and not ingress.get("customDomains"),
          f"{label}: ingress {ingress}, expected external HTTPS-only on 8080")
    # ADR-0071: with its own host name only the AzureFrontDoor.Backend ranges, else no restriction.
    want_rules = [{"name": f"afd-backend-{i}", "description": "AzureFrontDoor.Backend", "ipAddressRange": r, "action": "Allow"}
                  for i, r in enumerate(front_door.get("backendIpRanges") or [])] if host else []
    check((ingress.get("ipSecurityRestrictions") or []) == want_rules,
          f"{label}: ipSecurityRestrictions {ingress.get('ipSecurityRestrictions')}, expected {want_rules}")
    registries = cfg.get("registries", [])
    check(len(registries) == 1 and registries[0].get("identity") == identity
          and re.search(r"/registries/crcontosoprod[a-z0-9]{6}', '[0-9-]+'\)\.loginServer\]$", str(registries[0].get("server"))) is not None,
          f"{label}: registries {registries}, expected the platform registry with id-contoso-portal")
    check(cfg.get("secrets") in (None, []), f"{label}: secrets {cfg.get('secrets')}")
    containers = props.get("template", {}).get("containers", [])
    check(len(containers) == 1 and not props.get("template", {}).get("initContainers"), f"{label}: containers {len(containers)}")
    if containers:
        c = containers[0]
        check("/registries/crcontosoprod" in str(c.get("image")) and str(c.get("image")).endswith(f"'saf-portal', '{PORTAL_DIGEST}')]"),
              f"{label}: image {c.get('image')}, expected {{platform registry}}/saf-portal@{PORTAL_DIGEST}")
        env = {e.get("name"): e for e in c.get("env", [])}
        want_env = sorted([*PORTAL_ENV, "AZURE_CLIENT_ID", "SAF_DATABASE_HOST", "SAF_SMTP_PASSWORD_VAULT_URI", "SAF_FRONT_DOOR_ID"])
        check(sorted(env) == want_env and len(c.get("env", [])) == len(want_env) and not any("secretRef" in e for e in c.get("env", [])),
              f"{label}: env {sorted(env)}, expected exactly {want_env}")
        for name, value in PORTAL_ENV.items():
            check(env.get(name, {}).get("value") == value, f"{label}: {name} = {env.get(name, {}).get('value')!r}, expected {value!r}")
        # Always present (a plain list), empty without the SMTP secret's role: the image treats empty as unset.
        # The vault's DNS suffix is this cloud's (environment().suffixes.keyvaultDns, as release.bicep), which
        # a snapshot leaves as an expression.
        smtp_uri = env.get("SAF_SMTP_PASSWORD_VAULT_URI", {}).get("value")
        want_uri = [f"https://{vault}.vault.azure.net", f"[format('https://{{0}}{{1}}', '{vault}', environment().suffixes.keyvaultDns)]"] if smtp_secret else [""]
        check(smtp_uri in want_uri, f"{label}: SAF_SMTP_PASSWORD_VAULT_URI {smtp_uri!r}, expected one of {want_uri!r}")
        # ADR-0071: the profile's Front Door ID (read from the existing profile), or empty.
        fdid = str(env.get("SAF_FRONT_DOOR_ID", {}).get("value"))
        check((f"reference('{PROD_SUB_PROFILE}', '2025-04-15').frontDoorId" in fdid) if host else fdid == "",
              f"{label}: SAF_FRONT_DOOR_ID {fdid!r}, expected {'the frontDoorId of afd-contoso-prod' if host else 'empty'}")
        client = str(env.get("AZURE_CLIENT_ID", {}).get("value"))
        check(f"reference('{identity}'" in client and client.endswith(".clientId]"),
              f"{label}: AZURE_CLIENT_ID {client} is not the portal identity's client ID")
        host = str(env.get("SAF_DATABASE_HOST", {}).get("value"))
        check("format('sql-{0}'" in host and host.endswith(".outputs.fqdn.value]"),
              f"{label}: SAF_DATABASE_HOST {host} is not the portal server's FQDN")
        probes = {p.get("type"): p.get("httpGet") for p in c.get("probes", [])}
        check(probes == {"Liveness": {"path": "/healthz", "port": 8080}, "Readiness": {"path": "/readyz", "port": 8080}},
              f"{label}: probes {probes}")
    check(props.get("template", {}).get("scale", {}).get("minReplicas") == 1, f"{label}: minReplicas {props.get('template', {}).get('scale')}")


def check_portal_registration(compiled: dict[str, dict], snaps: dict[str, dict]) -> None:
    """portal-registration.bicep (ADR-0036): the example (prod host) and two variants: both
    platform groups the same, and a nonprod host with a localhost redirect URI."""
    name = "portal-registration.bicep"
    check_entra_graph_reference(compiled, name)
    # AGENTS.md rule 6: no parameter defaults, so a missing value fails loudly.
    defaults = sorted(n for n, p in (compiled.get(name) or {}).get("parameters", {}).items() if "defaultValue" in p)
    check(not defaults, f"{name}: parameters with a default: {defaults}")
    text = (INFRA / PORTAL_REGISTRATION_EXAMPLE).read_text()
    values = {k: re.search(rf"^param {k} = '([^']*)'$", text, re.M)
              for k in ("platformAdminsGroupId", "platformTeamGroupId", "portalHostName", "environmentName", "tenantId",
                        "portalIdentityPrincipalId")}
    missing = [k for k, m in values.items() if m is None]
    check(not missing, f"{PORTAL_REGISTRATION_EXAMPLE}: parameters {missing} not found")
    if missing:
        return
    admins, team, host, env, tenant, principal = (values[k].group(1) for k in values)
    check(tenant == TENANT, f"{PORTAL_REGISTRATION_EXAMPLE}: tenantId {tenant} is not the snapshot tenant {TENANT}")
    obo = (tenant, principal)
    main_uri = f"https://{host}/"
    check_portal_registration_snapshot("example", snaps.get(PORTAL_REGISTRATION_EXAMPLE), [admins, team], [main_uri],
                                       f"contoso-portal-{env}", obo)
    variants = [
        ("same group for both", [(values["platformTeamGroupId"].group(0), f"param platformTeamGroupId = '{admins}'")],
         [admins], [main_uri], f"contoso-portal-{env}"),
        ("nonprod host with a localhost URI",
         [(values["environmentName"].group(0), "param environmentName = 'nonprod'"),
          ("param environmentKind = 'prod'", "param environmentKind = 'nonprod'"),
          ("param devRedirectUris = []", "param devRedirectUris = [\n  'http://localhost:5173/'\n]")],
         [admins, team], [main_uri, "http://localhost:5173/"], "contoso-portal-nonprod"),
    ]
    with tempfile.TemporaryDirectory(prefix="saf-portal-registration-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
        for label, replacements, groups, uris, unique in variants:
            case_text = text
            for old, new in replacements:
                check(old in case_text, f"portal registration variant '{label}': marker '{old[:40]}' not found")
                case_text = case_text.replace(old, new, 1)
            case = (work / PORTAL_REGISTRATION_EXAMPLE).with_name("variant-case.bicepparam")
            case.write_text(case_text)
            rc, log, data = snapshot(case, EXAMPLES[PORTAL_REGISTRATION_EXAMPLE])
            check(rc == 0 and data is not None, f"portal registration variant '{label}' failed:\n{log[:1500]}")
            check_portal_registration_snapshot(label, data, groups, uris, unique, obo)
    print(f"{name}: example + {len(variants)} variants")


def check_portal_registration_snapshot(label: str, data: dict | None, groups: list[str], redirect_uris: list[str],
                                       unique_name: str, obo: tuple[str, str]) -> None:
    """obo = (tenant ID, principal ID of id-{prefix}-portal): the federated credential's issuer and subject."""
    where = f"portal registration {label}"
    resources = (data or {}).get("predictedResources", [])

    def of_type(t: str) -> list[dict]:
        return [r for r in resources if r.get("type") == f"Microsoft.Graph/{t}@v1.0"]

    want_groups = sorted({g.lower() for g in groups})
    counts: dict[str, int] = {}
    for r in resources:
        counts[r.get("type", "")] = counts.get(r.get("type", ""), 0) + 1
    want_counts = {"Microsoft.Graph/applications@v1.0": 2, "Microsoft.Graph/servicePrincipals@v1.0": 1,
                   "Microsoft.Graph/applications/federatedIdentityCredentials@v1.0": 1,
                   "Microsoft.Graph/oauth2PermissionGrants@v1.0": 3, "Microsoft.Graph/appRoleAssignedTo@v1.0": len(want_groups)}
    check(counts == want_counts, f"{where}: resources {counts}, expected {want_counts}")

    sp = "[reference('servicePrincipal').id]"
    apps = of_type("applications")
    for app in apps:
        props = app.get("properties", {})
        check(props.get("uniqueName") == unique_name, f"{where}: uniqueName {props.get('uniqueName')}, expected {unique_name}")
        check(not props.get("passwordCredentials") and not props.get("keyCredentials") and "web" not in props,
              f"{where}: application has credentials or a web platform: {sorted(props)}")
        check(props.get("groupMembershipClaims") == "ApplicationGroup", f"{where}: groupMembershipClaims {props.get('groupMembershipClaims')}")
        api = props.get("api", {})
        scopes = api.get("oauth2PermissionScopes", [])
        check(api.get("requestedAccessTokenVersion") == 2
              and [(s.get("value"), s.get("type"), s.get("isEnabled")) for s in scopes] == [("access_as_user", "User", True)],
              f"{where}: api {api}, expected v2 tokens and the one scope access_as_user")
        check(props.get("spa", {}).get("redirectUris") == redirect_uris,
              f"{where}: SPA redirect URIs {props.get('spa', {}).get('redirectUris')}, expected {redirect_uris}")
        want_access = [{"resourceAppId": GRAPH_APP_ID, "resourceAccess": [{"id": i, "type": "Scope"} for i in PORTAL_GRAPH_SCOPES.values()]},
                       {"resourceAppId": KEY_VAULT_APP_ID, "resourceAccess": [{"id": KEY_VAULT_USER_IMPERSONATION, "type": "Scope"}]}]
        check(props.get("requiredResourceAccess") == want_access,
              f"{where}: requiredResourceAccess {props.get('requiredResourceAccess')}, expected exactly the delegated Graph "
              f"scopes {list(PORTAL_GRAPH_SCOPES)} and Key Vault user_impersonation")
        check(not props.get("appRoles"), f"{where}: the portal application defines app roles {props.get('appRoles')}, expected none")
    identifier = [a.get("properties", {}).get("identifierUris") for a in apps if "identifierUris" in a.get("properties", {})]
    check(identifier == [["[format('api://{0}', reference('application').appId)]"]],
          f"{where}: identifierUris {identifier}, expected api://{{appId}} once")

    sps = of_type("servicePrincipals")
    check(len(sps) == 1 and sps[0].get("properties") == {"appId": "[reference('application').appId]", "appRoleAssignmentRequired": False},
          f"{where}: service principal {[s.get('properties') for s in sps]}, expected appRoleAssignmentRequired false and no credentials")

    grants = sorted((g["properties"].get("clientId"), g["properties"].get("consentType"), g["properties"].get("resourceId"),
                     g["properties"].get("scope")) for g in of_type("oauth2PermissionGrants"))
    want_grants = sorted([(sp, "AllPrincipals", "[reference('graphServicePrincipal').id]", " ".join(PORTAL_GRAPH_SCOPES)),
                          (sp, "AllPrincipals", "[reference('keyVaultServicePrincipal').id]", "user_impersonation"),
                          (sp, "AllPrincipals", sp, "access_as_user")])
    check(grants == want_grants, f"{where}: consent grants {grants}, expected exactly {want_grants}")

    # The OBO client credential (ADR-0040): id-{prefix}-portal as federated credential, nothing else.
    # environment().authentication.loginEndpoint is https://login.microsoftonline.com/ in the global
    # cloud; the snapshot leaves environment() unevaluated.
    tenant, principal = obo
    fics = of_type("applications/federatedIdentityCredentials")
    want_fic = {"name": f"{unique_name}/portal-obo",
                "issuer": f"[format('{{0}}{{1}}/v2.0', environment().authentication.loginEndpoint, '{tenant.lower()}')]",
                "subject": principal.lower(), "audiences": [TOKEN_EXCHANGE_AUDIENCE]}
    got_fic = [{k: f.get("properties", {}).get(k) for k in ("name", "issuer", "subject", "audiences")} for f in fics]
    check(got_fic == [want_fic], f"{where}: federated identity credentials {got_fic}, expected exactly {[want_fic]}")
    check(all(set(f.get("properties", {})) == {"name", "description", "issuer", "subject", "audiences"} for f in fics),
          f"{where}: federated identity credential with unexpected properties {[sorted(f.get('properties', {})) for f in fics]}")

    assignments = of_type("appRoleAssignedTo")
    check(all(a["properties"].get("resourceId") == sp and a["properties"].get("appRoleId") == DEFAULT_APP_ROLE for a in assignments)
          and sorted(str(a["properties"].get("principalId")).lower() for a in assignments) == want_groups,
          f"{where}: assignments {[a.get('properties') for a in assignments]}, expected the default role on its own "
          f"service principal for {want_groups}")


LZ_EXAMPLES = {"app/examples/hotel-inventory-nonprod.lz.bicepparam": ("nonprod", NONPROD_SUB),
               "app/examples/hotel-inventory-prod.lz.bicepparam": ("prod", PROD_SUB)}


def check_portal_reader(snaps: dict[str, dict]) -> None:
    """landing-zone.bicep (ADR-0037): Reader for portalIdentityPrincipalId at the app resource group
    only, and nothing else to that principal; '' assigns nothing and changes nothing else."""
    for rel, (env, sub) in LZ_EXAMPLES.items():
        text = (INFRA / rel).read_text()
        m = re.search(r"^param portalIdentityPrincipalId = '([^']*)'$", text, re.M)
        check(m is not None and GUID.fullmatch(m.group(1)) is not None, f"{rel}: portalIdentityPrincipalId with a GUID not found")
        if m is None:
            continue
        principal = m.group(1)
        resources = (snaps.get(rel) or {}).get("predictedResources", [])
        held = [r for r in resources if r.get("type") == "Microsoft.Authorization/roleAssignments"
                and str(r.get("properties", {}).get("principalId")).lower() == principal.lower()]
        rg = f"/subscriptions/{sub}/resourceGroups/rg-contoso-app-hotel-inventory-{env}"
        check(len(held) == 1, f"{rel}: the portal principal holds {len(held)} role assignments, expected exactly one")
        for a in held:
            props = a.get("properties", {})
            check(re.fullmatch(rf"{re.escape(rg)}/providers/Microsoft\.Authorization/roleAssignments/{GUID.pattern}", a["id"]) is not None
                  and GUID.fullmatch(str(a.get("name"))) is not None,
                  f"{rel}: portal Reader {a['id']} is not a fixed-name assignment at the app resource group")
            check(role_guid(a) == ROLE_READER and props.get("principalType") == "ServicePrincipal" and "condition" not in props,
                  f"{rel}: portal assignment {props}, expected Reader for a service principal without condition")
        # Without the principal: the same deployment minus that one assignment.
        with tempfile.TemporaryDirectory(prefix="saf-portal-reader-") as tmp:
            work = Path(tmp) / "infra"
            shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
            shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
            case = (work / rel).with_name("no-portal-case.bicepparam")
            case.write_text(text.replace(m.group(0), "param portalIdentityPrincipalId = ''"))
            rc, log, data = snapshot(case, EXAMPLES[rel])
            check(rc == 0 and data is not None, f"{rel} without portal principal failed:\n{log[:1500]}")
            check(predicted(data) == sorted(set(predicted(snaps.get(rel))) - {json.dumps(a, sort_keys=True) for a in held}),
                  f"{rel}: without portalIdentityPrincipalId the deployment must differ only by the portal's Reader")
    print(f"landing zone portal Reader: {len(LZ_EXAMPLES)} examples, with and without")


def check_registry_purge_role(snaps: dict[str, dict]) -> None:
    """landing-zone.bicep (ADR-0059): in a build environment exactly one Container Registry Repository
    Contributor assignment, on the app's own registry in its resource group, to the deployer
    (deployer().objectId: the provisioning identity in the pipeline); in a promotion environment none;
    the output registryPurgeRole says which."""
    for rel, (env, sub) in LZ_EXAMPLES.items():
        data = snaps.get(rel) or {}
        build = env == "nonprod"
        held = [r for r in data.get("predictedResources", []) if r.get("type") == "Microsoft.Authorization/roleAssignments"
                and role_guid(r) == ROLE_REGISTRY_PURGE]
        check(len(held) == (1 if build else 0), f"{rel}: {len(held)} registry purge role assignments, expected {1 if build else 0}")
        scope = re.compile(rf"\[extensionResourceId\('/subscriptions/{sub}/resourceGroups/rg-contoso-app-hotel-inventory-{env}/providers/"
                           r"Microsoft\.ContainerRegistry/registries/cr[a-z0-9]+', 'Microsoft\.Authorization/roleAssignments', ")
        for a in held:
            props = a.get("properties", {})
            check(scope.match(str(a.get("id"))) is not None, f"{rel}: the registry purge role is not on the app's own registry: {a.get('id')}")
            check(props.get("principalId") == "[deployer().objectId]" and props.get("principalType") == "ServicePrincipal"
                  and "condition" not in props and "deployer().objectId" in str(a.get("name")),
                  f"{rel}: the registry purge role must go to the deployer only (deployer().objectId), got {props.get('principalId')}")
        check(data.get("outputs", {}).get("registryPurgeRole") is build,
              f"{rel}: output registryPurgeRole is {data.get('outputs', {}).get('registryPurgeRole')!r}, expected {build}")
    print(f"registry purge role: {len(LZ_EXAMPLES)} landing-zone examples")


def check_landing_zone_outputs(snaps: dict[str, dict]) -> None:
    """G7: the smoke test needs the Container App's default host name before the release."""
    for rel in ("app/examples/hotel-inventory-nonprod.lz.bicepparam", "app/examples/hotel-inventory-prod.lz.bicepparam"):
        fqdn = (snaps.get(rel) or {}).get("outputs", {}).get("containerAppFqdn", "")
        check(re.fullmatch(r"\[format\('\{0\}\.\{1\}', 'ca-hotel-inventory', reference\('[^']*/providers/Microsoft\.App/"
                           r"managedEnvironments/cae-contoso-(ext|hyb)-[a-z]+', '[0-9-]+'\)\.defaultDomain\)\]", fqdn) is not None,
              f"{rel}: containerAppFqdn output is {fqdn!r}, expected ca-hotel-inventory.<CAE defaultDomain>")
    print("landing zone outputs: checked")


# ADR-0060 decision 4: the prepare pass of a network mode change (landing-zone.bicep `modeChange`).
# Variants of the two landing-zone examples: nonprod is External only on the managed network (case A),
# prod has externalOnlyNetwork vnet (case B). label -> (example, networkMode, fromNetworkMode or None
# for the steady state, hybridExistingVnetId or None).
MC_NONPROD = "app/examples/hotel-inventory-nonprod.lz.bicepparam"
MC_PROD = "app/examples/hotel-inventory-prod.lz.bicepparam"
MC_EXISTING_SPOKE = f"/subscriptions/{PROD_SUB}/resourceGroups/rg-network-prod/providers/Microsoft.Network/virtualNetworks/vnet-spoke-apps-prod"
MODE_CHANGE_CASES = {
    "A steady ext": (MC_NONPROD, "externalOnly", None, None),
    "A steady hyb": (MC_NONPROD, "externalHybrid", None, None),
    "A into hyb": (MC_NONPROD, "externalHybrid", "externalOnly", None),
    "A out of hyb": (MC_NONPROD, "externalOnly", "externalHybrid", None),
    "B steady ext": (MC_PROD, "externalOnly", None, None),
    "B steady hyb": (MC_PROD, "externalHybrid", None, None),
    "B steady hyb (existing spoke)": (MC_PROD, "externalHybrid", None, MC_EXISTING_SPOKE),
    "B into hyb": (MC_PROD, "externalHybrid", "externalOnly", None),
    "B out of hyb": (MC_PROD, "externalOnly", "externalHybrid", None),
    "B out of hyb (existing spoke)": (MC_PROD, "externalOnly", "externalHybrid", MC_EXISTING_SPOKE),
}
# The data services and the app vault: their public network access settings, and the managed network's
# "allow Azure services" firewall rules.
MC_DATA_TYPES = ("microsoft.keyvault/vaults", "microsoft.storage/storageaccounts", "microsoft.dbforpostgresql/flexibleservers",
                 "microsoft.sql/servers")
MC_ENDPOINT_TYPES = ("microsoft.network/privateendpoints", "microsoft.network/privateendpoints/privatednszonegroups")


def mc_variant(text: str, mode: str, from_mode: str | None, spoke: str | None) -> str:
    out = text
    change = "null" if from_mode is None else f"{{\n  phase: 'prepare'\n  fromNetworkMode: '{from_mode}'\n}}"
    vnet = f"'{spoke}'" if spoke else "null"
    for old, new in (
        (re.compile(r"^param networkMode = '[a-zA-Z]+'$", re.M), f"param networkMode = '{mode}'"),
        (re.compile(r"^param modeChange = null$", re.M), f"param modeChange = {change}"),
        (re.compile(r"^param hybridExistingVnetId = null$", re.M), f"param hybridExistingVnetId = {vnet}"),
    ):
        check(old.search(out) is not None, f"mode change: marker {old.pattern} not found")
        out = old.sub(new, out, count=1)
    return out


def mc_public(data: dict | None) -> dict[str, str]:
    """resource ID -> its public network access setting(s), for the data services and the app vault."""
    out = {}
    for r in (data or {}).get("predictedResources", []):
        t = str(r.get("type")).lower()
        p = r.get("properties", {})
        if t in MC_DATA_TYPES:
            out[r["id"]] = "/".join(str(x) for x in (p.get("publicNetworkAccess"), (p.get("network") or {}).get("publicNetworkAccess"),
                                                     (p.get("networkAcls") or {}).get("defaultAction")) if x is not None)
    return out


def mc_split(data: dict | None) -> tuple[list[str], list[str]]:
    """(endpoint resources, every other resource) of a snapshot, as canonical JSON. An endpoint's
    location is left out: the snapshot shows it as a reference to the CAE whose region the landing zone
    takes (the target's), and every CAE of an environment is in the environment's region."""
    endpoints, rest = [], []
    for r in (data or {}).get("predictedResources", []):
        if str(r.get("type")).lower() in MC_ENDPOINT_TYPES:
            endpoints.append(json.dumps({k: v for k, v in r.items() if k != "location"}, sort_keys=True))
        else:
            rest.append(json.dumps(r, sort_keys=True))
    return sorted(endpoints), sorted(rest)


def mc_normalized(data: dict | None) -> list[str]:
    """Every resource but the firewall rules, with the public network access settings removed."""
    out = []
    for r in (data or {}).get("predictedResources", []):
        t = str(r.get("type")).lower()
        if t.endswith("/firewallrules"):
            continue
        r = copy.deepcopy(r)
        if t in MC_DATA_TYPES:
            p = r.get("properties", {})
            p.pop("publicNetworkAccess", None)
            (p.get("network") or {}).pop("publicNetworkAccess", None)
            (p.get("networkAcls") or {}).pop("defaultAction", None)
        out.append(json.dumps(r, sort_keys=True))
    return sorted(out)


CELL_CASES = {
    "app/examples/hotel-inventory-nonprod.lz.bicepparam": "cae-contoso-ext-nonprod",
    "app/examples/hotel-inventory-nonprod.release.bicepparam": "cae-contoso-ext-nonprod",
    "app/examples/hotel-inventory-nonprod.frontdoor.bicepparam": "cae-contoso-ext-nonprod",
}


def check_cells() -> None:
    """The capacity cell (ADR-0053, ADR-0060 amendment 2026-11-16): landing-zone.bicep, release.bicep and
    frontdoor.bicep name the app's CAE in its cell: the examples (cell 01) name cae-{prefix}-{mode}-{env},
    the same examples with cell 02 name ...-c02 and never cell 01's CAE (the delivery identity's Joiner,
    the Container App's environment, the origin's default domain)."""
    with tempfile.TemporaryDirectory(prefix="saf-cells-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")

        def one(item):
            (rel, cae), cell = item
            text = (INFRA / rel).read_text()
            marker = re.compile(r"^param cell = '01'$", re.M)
            check(marker.search(text) is not None, f"cells: {rel} has no `param cell = '01'`")
            case = (work / rel).with_name(f"cell-{cell}-{Path(rel).name}")
            case.write_text(marker.sub(f"param cell = '{cell}'", text, count=1))
            rc, log, data = snapshot(case, EXAMPLES[rel], with_env("SAF_EASYAUTH_SECRET_EXISTS", "true"))
            check(rc == 0 and data is not None, f"cells: {rel} with cell {cell}: snapshot failed:\n{log[:1200]}")
            return rel, cae, cell, json.dumps((data or {}).get("predictedResources", []))

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(one, [(c, cell) for c in CELL_CASES.items() for cell in ("01", "02")]))
    for rel, cae, cell, resources in results:
        named = sorted(set(re.findall(r"cae-contoso-(?:ext|hyb)-nonprod(?:-c\d\d)?", resources)))
        want = cae if cell == "01" else f"{cae}-c{cell}"
        check(named == [want], f"cells: {rel} with cell {cell} names the CAEs {named}, expected only {want}")
    print(f"cells: {len(CELL_CASES)} templates name the CAE of the app's cell (01 and 02)")


def check_mode_change_prepare() -> None:
    """landing-zone.bicep `modeChange` (ADR-0060 decision 4): null is the steady state (the examples);
    the prepare pass, while the app still runs in the source CAE:
      - case A into externalHybrid: the steady hybrid landing zone, but public network access stays on
        (with the managed network's firewall rules) next to the target spoke's endpoints;
      - case A out of externalHybrid: exactly the steady External-only landing zone (no endpoint declared);
      - case B: the steady target landing zone (Joiner on the target CAE), with the endpoints of the
        source mode's (source spoke, its DNS zones) and public access off; with an existing hybrid
        spoke the endpoints are in it, also when the target is externalOnly;
    the delivery identity's Joiner on the target CAE only, and every case within the app's isolation
    allow-list (ADR-0052). The provisioning parameter file passes modeChange through."""
    with tempfile.TemporaryDirectory(prefix="saf-mode-change-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")

        def one(item):
            label, (rel, mode, from_mode, spoke) = item
            case = (work / rel).with_name(f"mc-{re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')}.bicepparam")
            case.write_text(mc_variant((INFRA / rel).read_text(), mode, from_mode, spoke))
            rc, log, data = snapshot(case, EXAMPLES[rel], with_env("SAF_EASYAUTH_SECRET_EXISTS", "true"))
            check(rc == 0 and data is not None and not (data or {}).get("diagnostics"), f"mode change {label}: snapshot failed:\n{log[:1200]}")
            return label, data

        with ThreadPoolExecutor(max_workers=4) as pool:
            snaps = dict(pool.map(one, MODE_CHANGE_CASES.items()))

    for label, (rel, mode, from_mode, _) in MODE_CHANGE_CASES.items():
        data = snaps.get(label)
        if data is None:
            continue
        env, sub = LZ_EXAMPLES[rel]
        abbr = {"externalOnly": "ext", "externalHybrid": "hyb"}
        joiners = sorted(r["id"] for r in data.get("predictedResources", []) if "/managedEnvironments/" in str(r.get("id")))
        check(len(joiners) == 1 and f"/managedEnvironments/cae-contoso-{abbr[mode]}-{env}/" in joiners[0],
              f"mode change {label}: the delivery identity's Joiner must be on cae-contoso-{abbr[mode]}-{env} only, got {joiners}")
        isolation_outside_ids(f"mode change {label}", data, {"slug": "hotel-inventory", "env": env, "sub": sub})
        secrets = [r["id"] for r in data.get("predictedResources", []) if "/secrets/easyauth-" in str(r.get("id"))]
        variant = "n" if mode == "externalHybrid" or rel == MC_PROD else "p"
        check(len(secrets) == 1 and re.search(rf"/vaults/kvcontoso{env}{variant}[a-z0-9]{{5}}/secrets/easyauth-hotel-inventory/", secrets[0]) is not None,
              f"mode change {label}: the Easy Auth role must be on the target variant's vault ({variant}), got {secrets}")
        if from_mode is not None:
            check(set(mc_public(data).values()) == ({"Disabled/Deny", "Disabled"} if rel == MC_PROD else {"Enabled/Allow", "Enabled"}),
                  f"mode change {label}: public network access of the data services and the app vault: {mc_public(data)}")

    get = snaps.get
    if all(get(k) is not None for k in MODE_CHANGE_CASES):
        a_ext, a_hyb, a_in, a_out = get("A steady ext"), get("A steady hyb"), get("A into hyb"), get("A out of hyb")
        check(predicted(a_out) == predicted(a_ext), "mode change A out of hyb: the prepare pass must be the steady External-only landing zone")
        check(mc_split(a_in)[0] == mc_split(a_hyb)[0] and mc_split(a_in)[0],
              "mode change A into hyb: the endpoints must be the steady hybrid landing zone's (target spoke)")
        check(mc_normalized(a_in) == mc_normalized(a_hyb),
              "mode change A into hyb: apart from public network access, the prepare pass must be the steady hybrid landing zone")
        def fw(d: dict) -> list[str]:
            return sorted(r["id"] for r in d.get("predictedResources", []) if str(r.get("type")).lower().endswith("/firewallrules"))
        check(fw(a_in) == fw(a_ext) and bool(fw(a_in)) and not fw(a_hyb),
              f"mode change A into hyb: the managed network's firewall rules stay ({fw(a_in)} vs {fw(a_ext)})")
        check(set(mc_public(a_ext).values()) == {"Enabled/Allow", "Enabled"} and set(mc_public(a_hyb).values()) == {"Disabled/Deny", "Disabled"},
              "mode change: the steady variants' public network access is not what the examples set")
        for label, target, source in (("B into hyb", "B steady hyb", "B steady ext"), ("B out of hyb", "B steady ext", "B steady hyb"),
                                      ("B out of hyb (existing spoke)", "B steady ext", "B steady hyb (existing spoke)")):
            want = sorted(mc_split(get(target))[1] + mc_split(get(source))[0])
            check(sorted(sum(mc_split(get(label)), [])) == want and bool(mc_split(get(source))[0]),
                  f"mode change {label}: must be '{target}' with the endpoints of '{source}' (source spoke, public access off)")
        spokes = {json.loads(e).get("properties", {}).get("subnet", {}).get("id", "").split("/subnets/")[0]
                  for e in mc_split(get("B out of hyb (existing spoke)"))[0] if json.loads(e)["type"].lower() == MC_ENDPOINT_TYPES[0]}
        check(spokes == {MC_EXISTING_SPOKE}, f"mode change B out of hyb (existing spoke): endpoints in {spokes}, expected the existing hybrid spoke")

    # The provisioning parameter file passes modeChange through: a prepare request from externalHybrid
    # for the nonprod input (managed network) gives the steady deployment (case A out of hybrid).
    fixture = json.loads((PROVISIONING / "examples" / "hotel-inventory-nonprod.lz.json").read_text())
    rc, log, steady = snapshot(PROVISIONING / "landing-zone.bicepparam", ["--subscription-id", NONPROD_SUB], with_env("SAF_LZ_JSON", json.dumps(fixture)))
    fixture["modeChange"] = {"phase": "prepare", "fromNetworkMode": "externalHybrid"}
    rc2, log2, prepared = snapshot(PROVISIONING / "landing-zone.bicepparam", ["--subscription-id", NONPROD_SUB], with_env("SAF_LZ_JSON", json.dumps(fixture)))
    check(rc == 0 and rc2 == 0 and predicted(prepared) == predicted(steady),
          f"mode change: the provisioning input with a prepare request from externalHybrid must give the steady nonprod deployment:\n{log[:300]}{log2[:600]}")
    fixture["networkMode"] = "externalHybrid"
    fixture["modeChange"] = {"phase": "prepare", "fromNetworkMode": "externalOnly"}
    rc3, log3, into = snapshot(PROVISIONING / "landing-zone.bicepparam", ["--subscription-id", NONPROD_SUB], with_env("SAF_LZ_JSON", json.dumps(fixture)))
    check(rc3 == 0 and set(mc_public(into).values()) == {"Enabled/Allow", "Enabled"} and mc_split(into)[0],
          f"mode change: the provisioning input into externalHybrid must keep public access with endpoints:\n{log3[:600]}")
    print(f"mode change prepare: {len(MODE_CHANGE_CASES)} landing-zone variants, provisioning input passed through")


def check_hand_built_names() -> None:
    hits = []
    for f in sorted(INFRA.rglob("*.bicep*")):
        if f.name == "naming.bicep" or f.suffix not in (".bicep", ".bicepparam"):
            continue
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if HAND_BUILT.search(line):
                hits.append(f"{f.relative_to(REPO)}:{i}: {line.strip()}")
    check(not hits, "hand-built names outside the naming module:\n  " + "\n  ".join(hits))
    print("hand-built names: checked")


IMPORT_STAR = re.compile(r"^\s*import\s+\*\s+as\s+\w+\s+from\s+'[^']*(naming|types)\.bicep'", re.M)


def check_selective_imports(compiled: dict[str, dict]) -> None:
    """Selective imports only (AGENTS.md rule 6): an exported definition a template doesn't use must
    not end up in its compiled JSON."""
    hits = [str(f.relative_to(REPO)) for f in sorted(INFRA.rglob("*.bicep"))
            if f.parent != INFRA / "tests" and IMPORT_STAR.search(f.read_text())]
    check(not hits, f"import * from naming.bicep or types.bicep (import selectively): {hits}")
    with tempfile.TemporaryDirectory(prefix="saf-imports-") as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(INFRA, work, ignore=shutil.ignore_patterns("*.snapshot.json", "__pycache__"))
        shutil.copy(REPO / "bicepconfig.json", Path(tmp) / "bicepconfig.json")
        types_file = work / "modules" / "types.bicep"
        types_file.write_text(types_file.read_text() + "\n@export()\ntype unusedProbeType = {\n  probe: string\n}\n"
                              "\n@export()\nvar unusedProbeValues = [\n  'probe'\n]\n")
        naming_file = work / "modules" / "naming" / "naming.bicep"
        naming_file.write_text(naming_file.read_text() + "\n@export()\nfunc unusedProbeName(prefix string) string => 'probe-${p(prefix)}'\n")
        changed = []
        for f in ENTRY_TEMPLATES:
            res = run(["az", "bicep", "build", "--file", str(work / f.relative_to(INFRA)), "--stdout"])
            if res.returncode != 0:
                failures.append(f"selective imports: build of {f.name} with probe definitions failed:\n{res.stderr[:600]}")
                continue
            if f.name in compiled and json.loads(res.stdout) != compiled[f.name]:
                changed.append(f.name)
        check(not changed, f"an unused exported type/variable/function changes the compiled template (and its hash): {changed}")
    print(f"selective imports: no import *, {len(ENTRY_TEMPLATES)} entry templates unchanged by unused exports")


# ---------------------------------------------------------------------------------------------
# App availability isolation (ADR-0052, AGENTS.md hard rule 10): deploying or changing one app never
# affects another. The app-scoped templates touch shared resources only as `existing`, and write
# outside the app's resource group only the allow-listed children named for the app.
# ---------------------------------------------------------------------------------------------

# The app-scoped templates and the scope each is deployed at: `subscription` (its app RG is the
# module scope ISOLATION_APP_RG_EXPR), `appRg` (the app's own RG) or `shared` (a platform or portal
# RG: everything it writes is outside the app RG and must be allow-listed).
ISOLATION_TEMPLATES = {
    "landing-zone.bicep": "subscription",
    "release.bicep": "appRg",
    "frontdoor.bicep": "shared",
    "portal-vault-endpoint.bicep": "shared",
}
ISOLATION_APP_RG_EXPR = "[variables('appRgName')]"
# Resource types every app shares (environment.bicep, portal.bicep, profile.bicep create them): an
# app-scoped template may only reference them as `existing`. An app's own Container Apps job
# (containerAppJob, not built yet) will need an exception for its own RG.
ISOLATION_SHARED_TYPES = {t.lower() for t in (
    "Microsoft.App/managedEnvironments", "Microsoft.App/jobs",
    "Microsoft.Cdn/profiles", "Microsoft.Cdn/profiles/afdEndpoints", "Microsoft.Cdn/profiles/securityPolicies",
    "Microsoft.Network/FrontDoorWebApplicationFirewallPolicies", "Microsoft.Network/virtualNetworks",
    "Microsoft.Network/virtualNetworks/subnets", "Microsoft.Network/networkSecurityGroups", "Microsoft.Network/routeTables",
    "Microsoft.Network/natGateways", "Microsoft.Network/publicIPAddresses", "Microsoft.Network/privateDnsZones",
    "Microsoft.Network/dnsZones", "Microsoft.OperationalInsights/workspaces",
)}
# Shared outside the app RG only (the app's own vault and registry live in its RG): the environment
# Key Vault and its secrets, another environment's registry.
ISOLATION_SHARED_OUTSIDE = {t.lower() for t in (
    "Microsoft.KeyVault/vaults", "Microsoft.KeyVault/vaults/secrets", "Microsoft.ContainerRegistry/registries",
)}
# Every write of an app-scoped template outside the app's RG: (template, symbolic name of the module or
# resource) -> reason. A module's own resources are its allowed children; shared types stay `existing`
# inside it too. An entry nothing matches fails (the list stays the truth).
ISOLATION_OUTSIDE_WRITES = {
    ("landing-zone.bicep", "joinerOnCae"):
        "App Environment Joiner for the app's delivery identity on the CAE (ADR-0021 row 2): one role "
        "assignment, named guid(CAE, the app's identity, role), in the platform RG.",
    ("landing-zone.bicep", "easyAuthOnSecret"):
        "Key Vault Secrets User for the app's Easy Auth identity on its own secret easyauth-{slug} in the "
        "environment vault (ADR-0009): one role assignment on that secret, in the platform RG.",
    ("landing-zone.bicep", "importerOnSourceRegistry"):
        "Data Importer for the app's delivery identity on its OWN registry in the promoteFrom environment "
        "(ADR-0021 row 6): the same app's RG of another environment.",
    ("frontdoor.bicep", "appRoute"):
        "The app's origin group og-{slug}-{env}, origin orig-{slug}-{env}, route route-{slug}-{env} and custom "
        "domain cd-{host} in the environment's shared Front Door profile (ADR-0010); profile and endpoint existing.",
    ("frontdoor.bicep", "dnsRecords"):
        "The CNAME {host} and TXT _dnsauth.{host} record sets in the public DNS zone of the host, marked "
        "saf-app/saf-env (ADR-0010, ADR-0052); the zone existing.",
    ("portal-vault-endpoint.bicep", "endpoint"):
        "The portal-side private endpoint pep-{app vault}-portal in the portal RG (ADR-0025): its name comes "
        "from the app's vault, whose name is globally unique.",
    ("portal-vault-endpoint.bicep", "zoneGroup"):
        "The DNS zone group `default` of that endpoint: registers the app vault's name in the portal's "
        "privatelink zone.",
}


def isolation_resources(template: dict):
    res = template.get("resources", {})
    return res.items() if isinstance(res, dict) else enumerate(res)


def isolation_walk(tname: str, template: dict, where: str, allowed: bool, used: set, path: str) -> None:
    """One template level. where: 'subscription' | 'app' | 'outside' (the scope of this level);
    allowed: inside an allow-listed module."""
    for sym, r in isolation_resources(template):
        t = str(r.get("type", "")).lower()
        existing = r.get("existing") is True
        label = f"{tname}: {path}{sym} ({r.get('type')})"
        if "resourceGroup" in r or "subscriptionId" in r:
            target = "app" if (where == "subscription" and r.get("resourceGroup") == ISOLATION_APP_RG_EXPR
                               and "subscriptionId" not in r) else "outside"
        else:
            target = where
        key = (tname, str(sym)) if path == "" else None
        listed = key in ISOLATION_OUTSIDE_WRITES
        if listed:
            used.add(key)
        check(t not in ISOLATION_SHARED_TYPES or existing,
              f"isolation: {label} creates or changes a shared resource; app-scoped templates reference it as existing only")
        check(t not in ISOLATION_SHARED_OUTSIDE or existing or target != "outside",
              f"isolation: {label} writes an environment vault, its secret or another registry outside the app RG; existing only")
        if t == "microsoft.resources/deployments":
            if target == "outside":
                check(allowed or listed, f"isolation: {label} deploys outside the app's resource group and is not in "
                                         "ISOLATION_OUTSIDE_WRITES (add it with the reason, or scope it to the app RG)")
                check("deployment().name" in str(r.get("name", "")),
                      f"isolation: {label} has a deployment name that doesn't derive from the app's deployment name "
                      f"({str(r.get('name'))[:80]}): another app's run would replace its deployment record")
            nested = r.get("properties", {}).get("template")
            if isinstance(nested, dict):
                isolation_walk(tname, nested, target, allowed or listed, used, f"{path}{sym}/")
            continue
        if existing:
            continue
        if target == "outside":
            check(allowed or listed, f"isolation: {label} is written outside the app's resource group and is not in "
                                     "ISOLATION_OUTSIDE_WRITES")
        elif target == "subscription":
            check(t == "microsoft.resources/resourcegroups" and r.get("name") == ISOLATION_APP_RG_EXPR,
                  f"isolation: {label} is a subscription-scope write other than the app's resource group")


def check_isolation_compiled(compiled: dict[str, dict]) -> None:
    """Compiled templates (nested modules included): shared types only `existing`, outside writes only
    through ISOLATION_OUTSIDE_WRITES, whose every entry is used."""
    used: set = set()
    for tname, scope in ISOLATION_TEMPLATES.items():
        if tname not in compiled:
            failures.append(f"isolation: {tname} was not built")
            continue
        isolation_walk(tname, compiled[tname], {"subscription": "subscription", "appRg": "app", "shared": "outside"}[scope],
                       False, used, "")
    stale = sorted(set(ISOLATION_OUTSIDE_WRITES) - used)
    check(not stale, f"isolation: ISOLATION_OUTSIDE_WRITES entries that match nothing (remove them): {stale}")
    check(all(len(reason) > 40 for reason in ISOLATION_OUTSIDE_WRITES.values()), "isolation: every outside write needs a reason")


# The snapshots: each app-scoped example of the app `hotel-inventory` (A) and the fixture of the app
# `hotelinventory` (B, infra/tests/isolation/) in the same environment, with confusable inputs.
# (label, param file relative to infra/, snapshot arguments, environment, app facts)
ISO_A = {"slug": "hotel-inventory", "fixture": "app/examples/hotel-inventory"}
ISO_B = {"slug": "hotelinventory", "fixture": "tests/isolation/hotelinventory"}
ISOLATION_ZONE = {"rg": "rg-dns", "zone": "contoso.com"}
ISOLATION_HOSTS = {"hotel-inventory": "hotel-inventory-test.contoso.com", "hotelinventory": "hotel-inventory.test.contoso.com"}
# What two apps may still share outside their RGs, and why. The custom-domain name isn't injective
# (naming-vectors.json confusable); the fixture's host is a confusable one on purpose, so the test
# shows the case validation must stop: `platform validate app` rejects the pair
# (front-door-domain-name, ADR-0052), and renaming would re-create existing domains.
ISOLATION_EXPECTED_SHARED = {
    "/subscriptions/00000000-0000-0000-0000-00000000a001/resourcegroups/rg-contoso-platform-nonprod/providers/"
    "microsoft.cdn/profiles/afd-contoso-nonprod/customdomains/cd-hotel-inventory-test-contoso-com":
        "cd-{host} is not injective; platform validate app rejects two apps of one environment with such hosts "
        "(check front-door-domain-name).",
}


def isolation_cases(app: dict) -> list[tuple[str, str, list[str], dict[str, str], dict]]:
    slug, base = app["slug"], app["fixture"]
    lz_env = with_env("SAF_EASYAUTH_SECRET_EXISTS", "true")
    out = []
    for env, sub in (("nonprod", NONPROD_SUB), ("prod", PROD_SUB)):
        facts = {"slug": slug, "env": env, "sub": sub, "fromEnv": "nonprod" if env == "prod" else None}
        out.append((f"{slug} lz {env}", f"{base}-{env}.lz.bicepparam", ["--subscription-id", sub], lz_env, facts))
        out.append((f"{slug} release {env}", f"{base}-{env}.release.bicepparam",
                    ["--subscription-id", sub, "--resource-group", f"rg-contoso-app-{slug}-{env}"], with_env("", None), facts))
    out.append((f"{slug} frontdoor nonprod", f"{base}-nonprod.frontdoor.bicepparam",
                ["--subscription-id", NONPROD_SUB, "--resource-group", "rg-contoso-platform-nonprod",
                 "--deployment-name", f"fd-{slug}-nonprod"], with_env("", None),
                {"slug": slug, "env": "nonprod", "sub": NONPROD_SUB, "host": ISOLATION_HOSTS[slug]}))
    out.append((f"{slug} portal endpoint prod", f"{base}-prod.portal-endpoint.bicepparam",
                ["--subscription-id", PROD_SUB, "--resource-group", "rg-contoso-portal-prod",
                 "--deployment-name", f"pep-portal-{slug}-prod"], with_env("", None),
                {"slug": slug, "env": "prod", "sub": PROD_SUB, "portalEnv": "prod"}))
    return out


GUID_RX = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def isolation_patterns(f: dict) -> list[tuple[re.Pattern[str], str, bool]]:
    """The IDs an app may write outside its RG (lower case), built from slug, env, host and naming, each
    with its reason and whether the app's own name is in it (False: the name part is a GUID or the app
    hash, per app by construction but not by pattern; the snapshots show those IDs disjoint)."""
    p, slug, env, sub = "contoso", re.escape(f["slug"]), re.escape(f["env"]), re.escape(f["sub"])
    sc = re.escape(f["slug"].replace("-", ""))
    sc16 = re.escape(f["slug"].replace("-", "")[:16])
    platform = f"/subscriptions/{sub}/resourcegroups/rg-{p}-platform-{env}/providers"
    profile = f"{platform}/microsoft\\.cdn/profiles/afd-{p}-{env}"
    pats = [
        (f"{platform}/microsoft\\.app/managedenvironments/cae-{p}-(ext|hyb|int)-{env}/providers/"
         f"microsoft\\.authorization/roleassignments/{GUID_RX}", "Joiner role of the app's delivery identity on its CAE", False),
        (f"{platform}/microsoft\\.keyvault/vaults/kv{p}{env}[pn][a-z0-9]{{5}}/secrets/easyauth-{slug}/providers/"
         f"microsoft\\.authorization/roleassignments/{GUID_RX}", "Secrets User on the app's own secret easyauth-{slug}", True),
        (f"/subscriptions/{GUID_RX}/resourcegroups/rg-{p}-app-{slug}-(?P<from>[a-z][a-z0-9]{{1,7}})/providers/"
         f"microsoft\\.containerregistry/registries/cr{p}{sc}(?P=from)[a-z0-9]{{6}}/providers/"
         f"microsoft\\.authorization/roleassignments/{GUID_RX}", "Data Importer on the app's own registry of promoteFrom", True),
        (f"{profile}/origingroups/og-{slug}-{env}", "the app's origin group", True),
        (f"{profile}/origingroups/og-{slug}-{env}/origins/orig-{slug}-{env}", "the app's origin", True),
        (f"{profile}/afdendpoints/fde-{p}-{env}/routes/route-{slug}-{env}", "the app's route", True),
        (f"/subscriptions/{sub}/resourcegroups/rg-{p}-portal-[a-z][a-z0-9]{{1,7}}/providers/microsoft\\.network/"
         f"privateendpoints/pep-kv{sc16}[a-z0-9]{{6}}-portal(/privatednszonegroups/default)?",
         "the portal-side endpoint of the app's vault and its zone group", False),
    ]
    if f.get("host"):
        host = f["host"].lower()
        rel = re.escape(host.removesuffix("." + ISOLATION_ZONE["zone"]))
        zone = f"/subscriptions/{sub}/resourcegroups/{ISOLATION_ZONE['rg']}/providers/microsoft\\.network/dnszones/" \
               f"{re.escape(ISOLATION_ZONE['zone'])}"
        pats += [
            (f"{profile}/customdomains/cd-{re.escape(host.replace('.', '-'))}", "the custom domain of the app's host", True),
            (f"{zone}/cname/{rel}", "the CNAME of the app's host", True),
            (f"{zone}/txt/_dnsauth\\.{rel}", "the validation TXT of the app's host", True),
        ]
    return [(re.compile(rx + r"\Z"), reason, named) for rx, reason, named in pats]


EXPRESSION_ID = re.compile(r"^\[resourceId\('([^']+)', '([^']+)', ")
# An extension resource on a literal scope whose name is an expression (ADR-0059: the registry purge role's
# assignment name holds deployer().objectId, which a snapshot doesn't evaluate): judged by its scope.
EXTENSION_EXPRESSION_ID = re.compile(r"^\[extensionResourceId\('(/subscriptions/[^']+)', '([^']+)', ")


def isolation_outside_ids(label: str, data: dict, f: dict) -> set[str]:
    """Every predicted resource ID is under the app RG or matches an allowed pattern; returns the others
    (outside the app RG), lower case."""
    app_rg = f"/subscriptions/{f['sub']}/resourcegroups/rg-contoso-app-{f['slug']}-{f['env']}".lower()
    pats = isolation_patterns(f)
    outside = set()
    for r in data.get("predictedResources", []):
        rid = str(r.get("id", ""))
        m = EXPRESSION_ID.match(rid)
        x = EXTENSION_EXPRESSION_ID.match(rid)
        lid = f"/subscriptions/{m.group(1)}/resourcegroups/{m.group(2)}/(expression)".lower() if m \
            else f"{x.group(1)}/providers/{x.group(2)}/(expression)".lower() if x else rid.lower()
        if lid == app_rg or lid.startswith(app_rg + "/"):
            continue
        check(not lid.startswith("["), f"isolation {label}: unresolved resource ID {rid[:120]}")
        check(any(rx.match(lid) for rx, _, _ in pats),
              f"isolation {label}: {r.get('type')} {rid} is outside rg-contoso-app-{f['slug']}-{f['env']} and matches "
              "no allowed pattern (ADR-0052)")
        outside.add(lid)
    return outside


def check_isolation(compiled: dict[str, dict]) -> None:
    """ADR-0052: compiled rule, then snapshots of the app-scoped examples (app A) and of the fixtures of a
    second app B in the same environments with confusable inputs; A's and B's writes outside their own
    resource groups are disjoint except ISOLATION_EXPECTED_SHARED."""
    check_isolation_compiled(compiled)
    cases = isolation_cases(ISO_A) + isolation_cases(ISO_B)

    def one(case):
        label, rel, args, env, facts = case
        rc, log, data = snapshot(INFRA / rel, args, env)
        return label, rc, log, data, facts

    outside: dict[str, set[str]] = {ISO_A["slug"]: set(), ISO_B["slug"]: set()}
    covered = {"joinerOnCae": False, "easyAuthOnSecret": False, "importer": False, "fd": False, "dns": False, "pep": False}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for label, rc, log, data, facts in pool.map(one, cases):
            check(rc == 0 and data is not None and not (data or {}).get("diagnostics"),
                  f"isolation: snapshot {label} failed:\n{log[:1200]}")
            if data is None:
                continue
            ids = isolation_outside_ids(label, data, facts)
            outside[facts["slug"]] |= ids
            joined = "\n".join(ids)
            covered["joinerOnCae"] |= "/managedenvironments/" in joined
            covered["easyAuthOnSecret"] |= "/secrets/easyauth-" in joined
            covered["importer"] |= "/microsoft.containerregistry/registries/" in joined
            covered["fd"] |= "/routes/route-" in joined
            covered["dns"] |= "/dnszones/" in joined
            covered["pep"] |= "-portal/privatednszonegroups/default" in joined
    check(all(covered.values()), f"isolation: the snapshots don't cover every allowed outside write: {covered}")
    shared = outside[ISO_A["slug"]] & outside[ISO_B["slug"]]
    check(shared == set(ISOLATION_EXPECTED_SHARED),
          f"isolation: apps {ISO_A['slug']} and {ISO_B['slug']} of one environment write the same resources outside "
          f"their RGs: {sorted(shared - set(ISOLATION_EXPECTED_SHARED))}; expected only {sorted(ISOLATION_EXPECTED_SHARED)}, "
          f"missing {sorted(set(ISOLATION_EXPECTED_SHARED) - shared)}")
    # The allow-list itself is per app: no pattern of B that carries B's name admits one of A's
    # writes (and the other way).
    for mine, other in ((ISO_A, ISO_B), (ISO_B, ISO_A)):
        for *_, facts in isolation_cases(other):
            pats = [rx for rx, _, named in isolation_patterns(facts) if named]
            leaks = sorted(i for i in outside[mine["slug"]] - set(ISOLATION_EXPECTED_SHARED) if any(rx.match(i) for rx in pats))
            check(not leaks, f"isolation: the allowed patterns of {other['slug']} ({facts['env']}) admit writes of {mine['slug']}: {leaks}")
    print(f"isolation: {len(ISOLATION_TEMPLATES)} templates compiled-checked, {len(cases)} snapshots, "
          f"{len(outside[ISO_A['slug']])}/{len(outside[ISO_B['slug']])} outside writes, shared: {len(shared)} (expected)")


# Provisioning units (ADR-0048 section 2): the templates and parameter files of each unit, in the
# order they enter its fingerprint. `ado` has none: its fingerprint covers its revision alone.
UNITS_FILE = INFRA / "app" / "units.json"
UNIT_FILES: dict[str, tuple[list[Path], list[Path]]] = {
    "lz": ([INFRA / "app" / "landing-zone.bicep"], [INFRA / "app" / "provisioning" / "landing-zone.bicepparam"]),
    "entra": ([INFRA / "entra" / "app-registration.bicep"], [INFRA / "entra" / "provisioning" / "app-registration.bicepparam"]),
    "release": ([INFRA / "app" / "release.bicep"], [INFRA / "app" / "provisioning" / "release.bicepparam"]),
    "frontdoor": ([INFRA / "app" / "frontdoor.bicep"], [INFRA / "app" / "provisioning" / "frontdoor.bicepparam"]),
    "pep": ([INFRA / "app" / "portal-vault-endpoint.bicep"], [INFRA / "app" / "provisioning" / "portal-endpoint.bicepparam"]),
    "ado": ([], []),
}
UNITS_DESCRIPTION = ("Provisioning units of an app (ADR-0048 section 2). Generated: python3 infra/tests/check-infra.py "
                     "--update-units (core CI fails when stale). fingerprint = sha256 of the unit's compiled templates "
                     "(_generator metadata removed, canonical JSON), its .bicepparam files and its revision, each part "
                     "length-prefixed. Edit only `revision`, by hand, when a script changes what the unit does in Azure "
                     "while its template and inputs stay the same. since = the core version since which the fingerprint "
                     "is unchanged; `unreleased` until tools/scripts/release-units.mjs <version> at release time.")
UNIT_SINCE = re.compile(r"^(unreleased|v\d+\.\d+\.\d+(-rc\.\d+)?)$")


def strip_generator(node):
    """The template without every `_generator` object (bicep version and template hash), at every level."""
    if isinstance(node, dict):
        return {k: strip_generator(v) for k, v in node.items() if k != "_generator"}
    if isinstance(node, list):
        return [strip_generator(v) for v in node]
    return node


def canonical_json(node) -> bytes:
    return json.dumps(node, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def unit_fingerprint(templates: list[dict], params: list[bytes], revision: int) -> str:
    """sha256 over length-prefixed parts: each compiled template (canonical, no _generator), each
    .bicepparam file's bytes, the revision in decimal. The prefix `<byte length>:` makes the encoding
    prefix-free, so two different part lists never give the same bytes."""
    h = hashlib.sha256()
    parts = [canonical_json(strip_generator(t)) for t in templates] + params + [str(revision).encode("ascii")]
    for part in parts:
        h.update(f"{len(part)}:".encode("ascii"))
        h.update(part)
    return h.hexdigest()


def compile_unit_templates(compiled: dict[str, dict] | None = None) -> dict[Path, dict]:
    """The unit templates, from the build of all entry templates when given, else built here."""
    out: dict[Path, dict] = {}
    for templates, _ in UNIT_FILES.values():
        for f in templates:
            if compiled is not None and f in ENTRY_TEMPLATES and f.name in compiled:
                out[f] = compiled[f.name]
                continue
            res = run(["az", "bicep", "build", "--file", str(f), "--stdout"])
            if res.returncode != 0:
                failures.append(f"units: build {f.relative_to(REPO)} failed:\n{res.stderr[:600]}")
                continue
            out[f] = json.loads(res.stdout)
    return out


def expected_units(current: dict, built: dict[Path, dict]) -> dict:
    """The manifest as it should be: the current revisions (default 1), fresh fingerprints, `since`
    kept when the fingerprint is unchanged and `unreleased` otherwise."""
    old = current.get("units", {}) if isinstance(current, dict) else {}
    units = {}
    for name, (templates, params) in UNIT_FILES.items():
        prev = old.get(name) if isinstance(old.get(name), dict) else {}
        revision = prev.get("revision", 1)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            failures.append(f"units: {name}.revision must be an integer >= 1, not {revision!r}")
            revision = 1
        fp = unit_fingerprint([built[f] for f in templates if f in built], [p.read_bytes() for p in params], revision)
        since = prev.get("since") if prev.get("fingerprint") == fp and isinstance(prev.get("since"), str) else "unreleased"
        units[name] = {"revision": revision, "fingerprint": fp, "since": since}
    return {"description": UNITS_DESCRIPTION, "schemaVersion": 1, "units": units}


def load_units() -> dict:
    return json.loads(UNITS_FILE.read_text()) if UNITS_FILE.exists() else {}


def write_units(manifest: dict) -> None:
    UNITS_FILE.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def check_units(compiled: dict[str, dict]) -> None:
    """infra/app/units.json is current: same units, fingerprints and shape as --update-units would write."""
    current = load_units()
    check(bool(current), f"units: {UNITS_FILE.relative_to(REPO)} is missing (python3 infra/tests/check-infra.py --update-units)")
    built = compile_unit_templates(compiled)
    want = expected_units(current, built)
    for name, unit in (current.get("units") or {}).items():
        check(name in UNIT_FILES, f"units: unknown unit {name!r} in {UNITS_FILE.relative_to(REPO)}")
        if isinstance(unit, dict):
            check(isinstance(unit.get("since"), str) and bool(UNIT_SINCE.match(unit["since"])),
                  f"units: {name}.since {unit.get('since')!r} is neither `unreleased` nor vMAJOR.MINOR.PATCH[-rc.N]")
    stale = [n for n in UNIT_FILES if (current.get("units") or {}).get(n, {}).get("fingerprint") != want["units"][n]["fingerprint"]]
    check(current.get("schemaVersion") == 1, "units: schemaVersion must be 1")
    check(not stale and current == want,
          f"units: {UNITS_FILE.relative_to(REPO)} is stale (changed: {stale or 'shape'}); "
          "run python3 infra/tests/check-infra.py --update-units and commit it")
    print(f"units: {len(UNIT_FILES)} fingerprints checked")


def update_units() -> int:
    built = compile_unit_templates()
    if failures:
        print("\n".join(failures))
        return 1
    current = load_units()
    want = expected_units(current, built)
    changed = [n for n in UNIT_FILES if (current.get("units") or {}).get(n, {}).get("fingerprint") != want["units"][n]["fingerprint"]]
    write_units(want)
    print(f"updated {UNITS_FILE.relative_to(REPO)}; changed fingerprints: {', '.join(changed) or 'none'}")
    return 0


def main() -> int:
    if "--update-units" in sys.argv[1:]:
        return update_units()
    lint_all()
    compiled = build_entries()
    check_units(compiled)  # before any check that might touch the compiled templates
    check_roles(compiled)
    check_entra_graph_reference(compiled)
    check_entra_no_defaults(compiled)
    check_hand_built_names()
    check_selective_imports(compiled)
    snaps = snapshots()
    check_bootstrap(compiled, snaps)
    check_entra_permissions(compiled, snaps)
    check_entra_audit_alert(snaps)
    check_kvset_jobs(snaps)
    check_front_door(snaps)
    check_front_door_app(compiled, snaps)
    check_portal_endpoint(compiled, snaps)
    check_isolation(compiled)
    check_portal_readers(snaps)
    check_portal(snaps)
    check_portal_registration(compiled, snaps)
    check_landing_zone_outputs(snaps)
    check_registry_purge_role(snaps)
    check_portal_reader(snaps)
    check_mode_change_prepare()
    check_cells()
    check_names_environment_vault(snaps)
    delivery_params()
    provisioning_params()
    check_platform_pipeline(snaps)
    check_instance_onboarding(snaps)


    check_front_door_lockdown(compiled)
    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all infra checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
