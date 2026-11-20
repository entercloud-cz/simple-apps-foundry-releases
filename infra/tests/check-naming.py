#!/usr/bin/env python3
"""Naming module tests (ADR-0020, backlog US03.01, US03.02).

1. Builds infra/modules/naming/naming.bicep and infra/tests/naming.tests.bicep to ARM JSON
   (`az bicep build`), so the module compiles with the repo's linter settings.
2. Evaluates the test matrix locally with `bicep snapshot` (the deployment engine's own
   expression evaluator: format/take/replace/uniqueString/fail run exactly as in Azure; no
   Azure access, no login). The inputs are the cases of the shared test vectors,
   infra/tests/naming-vectors.json.
3. Asserts every name against two oracles. The patterns in `expected()` (prefix `contoso`,
   environments `nonprod`/`prod`, slug `hotel-inventory`, a 20-character slug and the maximum
   input lengths prefix 8, env 8, slug 20, job key 6) hold the structure; hash parts (h6, h5)
   are asserted for length and charset, for being the same across one app's names, and for
   changing with `generation`. The shared vectors hold the exact names, hashes included, and
   the TypeScript ports (portal/shared, platform CLI) are tested against the same file, so
   Bicep and TypeScript cannot drift. A name the module computes without a vector, or a vector
   without a name, fails. After a deliberate change to naming.bicep, review it and regenerate
   the vectors' `names` with `python3 infra/tests/check-naming.py --update-vectors`.
4. Asserts every name stays within its Azure limit and character rules, including the
   24-character Key Vault limit, and that the public and private environment vault differ.
   The platform registry (ADR-0035) never equals the app registry of the same prefix and
   environment, and its hash differs from the app's h6.
   Custom role definition GUIDs (app-deployer, app-environment-joiner, entra-deployment-operator,
   platform-job-secret-writer) are GUIDs, distinct, and depend on the prefix only.
   Portal names (ADR-0036, ADR-0025, ADR-0038): the portal RG, Container App and PostgreSQL server
   (with its own hash and private endpoint), and the portal network (mode token `portal`), distinct
   from every network-mode and app name of the same environment; the deployment
   pep-portal-{slug}-{env} of an app vault's portal-side private endpoint differs from every other
   deployment name.
   Capacity cells (ADR-0053): cell 01 keeps today's CAE, subnet, NSG and job names; a later cell's
   names (suffix -c{cell}) differ from every existing name.
   Front Door per app (ADR-0010, amended 2026-11-01): the deployment fd-{slug}-{env} and the DNS
   record names of a host in its zone (CNAME and _dnsauth TXT, relative to the zone).
   Entra uniqueName per incarnation (ADR-0061): {prefix}-{slug}-{env} for incarnation 0 (unchanged for
   every existing app), {prefix}-{slug}-{env}--i{n} above it; only an incarnation above 0 has `--`.
5. Negative cases (the vectors' `invalid` list; the TypeScript ports must reject the same inputs):
   invalid inputs must stop evaluation with a `naming:` fail() message. The
   `portal` token is accepted only by the network-name functions (not by managedEnvironment). A host
   outside its DNS zone or at the zone apex has no record name.
6. Injectivity (ADR-0052, app availability isolation): the vectors' `confusable` pairs are two apps of
   one environment with confusable slugs (ab-cd / a-bcd, hotel-inventory / hotelinventory, the same
   first 16 compact characters) and hosts (x-y.zone / x.y.zone), and one pair of two environments for
   the incarnation suffix (orders in nonprod with incarnation 1 / orders-nonprod in an environment named
   i1: with a single hyphen both registrations would be contoso-orders-nonprod-i1). Exactly the names each pair lists in
   `collisions` may be equal, and each must have its reason in `knownNonInjective`; any other equal
   name fails. Names that differ only through h6 are printed (the hash keeps them apart).

Usage: python3 infra/tests/check-naming.py [--update-vectors]   (needs Azure CLI with Bicep >= 0.46, Python 3.10+)
Exit code 0 = all checks passed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NAMING = REPO / "infra" / "modules" / "naming" / "naming.bicep"
TESTS = REPO / "infra" / "tests" / "naming.tests.bicep"
VECTORS = REPO / "infra" / "tests" / "naming-vectors.json"

SNAPSHOT_SUB = "00000000-0000-0000-0000-00000000a001"
HASH = "[a-z0-9]"
GUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
CUSTOM_ROLE_KEYS = ("customRoleAppDeployer", "customRoleAppEnvironmentJoiner", "customRoleEntraDeploymentOperator",
                    "customRolePlatformJobSecretWriter")

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def bicep_binary() -> str:
    """`bicep snapshot` isn't exposed through `az bicep`; use the binary az installed."""
    for candidate in (shutil.which("bicep"), str(Path.home() / ".azure" / "bin" / "bicep")):
        if candidate and Path(candidate).is_file():
            return candidate
    sys.exit("check-naming: bicep CLI not found (run `az bicep install`).")


def az_build(path: Path, outdir: Path) -> None:
    result = subprocess.run(
        ["az", "bicep", "build", "--file", str(path), "--outdir", str(outdir)],
        capture_output=True, text=True,
    )
    errors = [l for l in result.stderr.splitlines() if ": Error " in l or l.startswith("ERROR")]
    check(result.returncode == 0 and not errors, f"az bicep build {path.name} failed:\n{result.stderr}")


def snapshot(workdir: Path, params_text: str) -> tuple[int, dict | None, str]:
    """Write a .bicepparam next to the copied test template and snapshot it."""
    param_file = workdir / "infra" / "tests" / "case.bicepparam"
    param_file.write_text(params_text)
    out_file = param_file.with_suffix(".snapshot.json")
    if out_file.exists():
        out_file.unlink()
    result = subprocess.run(
        [bicep_binary(), "snapshot", str(param_file), "--subscription-id", SNAPSHOT_SUB,
         "--location", "westeurope"],
        capture_output=True, text=True,
    )
    data = json.loads(out_file.read_text()) if result.returncode == 0 and out_file.exists() else None
    return result.returncode, data, result.stdout + result.stderr


# ---------------------------------------------------------------------------------------------
# Expected names. {h6}/{h5} stand for hash parts (asserted by shape and consistency).
# ---------------------------------------------------------------------------------------------

def expected(prefix: str, env: str, slug: str, job: str, host: str, incarnation: int = 0) -> dict[str, str]:
    sc = slug.replace("-", "")
    return {
        # platform
        "platformResourceGroup": f"rg-{prefix}-platform-{env}",
        "privateDnsResourceGroupExt": f"rg-{prefix}-dns-ext-{env}",
        "privateDnsResourceGroupHyb": f"rg-{prefix}-dns-hyb-{env}",
        "logAnalyticsWorkspace": f"log-{prefix}-{env}",
        "platformActionGroup": f"ag-{prefix}-platform-{env}",
        "platformActionGroupShortName": f"p-{prefix[:5]}-{env[:4]}",
        "diagnosticSetting": f"diag-{prefix}-{env}",
        "caeExt": f"cae-{prefix}-ext-{env}",
        "caeHyb": f"cae-{prefix}-hyb-{env}",
        "caeInt": f"cae-{prefix}-int-{env}",
        "caePortal": f"cae-{prefix}-portal-{env}",
        "caeByMode": f"cae-{prefix}-ext-{env}",
        "portalResourceGroup": f"rg-{prefix}-portal-{env}",
        "portalContainerApp": f"ca-{prefix}-portal",
        "portalPostgresServer": f"pgsql-{prefix}-portal-{env}-{{h6d}}",
        "portalPostgresDatabase": "portal",
        "pepPortalPostgres": f"pep-pgsql-{prefix}-portal-{env}-{{h6d}}",
        "portalSqlServer": f"sql-{prefix}-portal-{env}-{{h6d}}",
        "portalSqlDatabase": "portal",
        "pepPortalSql": f"pep-sql-{prefix}-portal-{env}-{{h6d}}",
        "vnetPortal": f"vnet-{prefix}-portal-{env}",
        "snetCaePortal": f"snet-{prefix}-cae-portal-{env}",
        "snetPepPortal": f"snet-{prefix}-pep-portal-{env}",
        "nsgCaePortal": f"nsg-{prefix}-cae-portal-{env}",
        "nsgPepPortal": f"nsg-{prefix}-pep-portal-{env}",
        "natGatewayPortal": f"ng-{prefix}-portal-{env}",
        "natPublicIpPortal01": f"pip-{prefix}-ng-portal-{env}-01",
        "dnsZoneLinkPortal": f"link-vnet-{prefix}-portal-{env}",
        "vnetExt": f"vnet-{prefix}-ext-{env}",
        "vnetHyb": f"vnet-{prefix}-hyb-{env}",
        "snetCaeExt": f"snet-{prefix}-cae-ext-{env}",
        "snetPepHyb": f"snet-{prefix}-pep-hyb-{env}",
        "nsgCaeHyb": f"nsg-{prefix}-cae-hyb-{env}",
        "nsgPepExt": f"nsg-{prefix}-pep-ext-{env}",
        "natGatewayExt": f"ng-{prefix}-ext-{env}",
        "natPublicIp01": f"pip-{prefix}-ng-ext-{env}-01",
        "natPublicIp16": f"pip-{prefix}-ng-ext-{env}-16",
        "hubPeeringHyb": f"peer-{prefix}-hyb-{env}-to-hub",
        "dnsZoneLinkHyb": f"link-vnet-{prefix}-hyb-{env}",
        "envVaultPublic": f"kv{prefix}{env}p{{h5}}",
        "envVaultPrivate": f"kv{prefix}{env}n{{h5}}",
        "envVaultPrivateNextGeneration": f"kv{prefix}{env}n{{h5}}",
        "envVaultPrivatePepHyb": f"pep-kv{prefix}{env}n{{h5}}-hyb",
        "platformRegistry": f"cr{prefix}{env}{{h6p}}",
        "platformJobDbinitExt": f"caj-{prefix}-dbinit-ext",
        "platformJobKvsetExt": f"caj-{prefix}-kvset-ext",
        "platformJobKvsetHyb": f"caj-{prefix}-kvset-hyb",
        # capacity cells (ADR-0053): cell 01 keeps the names above, a later cell (02 in the vectors) gets -c02
        "caeExtCell01": f"cae-{prefix}-ext-{env}",
        "caeExtCell": f"cae-{prefix}-ext-{env}-c02",
        "caeHybCell": f"cae-{prefix}-hyb-{env}-c02",
        "snetCaeExtCell01": f"snet-{prefix}-cae-ext-{env}",
        "snetCaeHybCell": f"snet-{prefix}-cae-hyb-{env}-c02",
        "nsgCaeHybCell01": f"nsg-{prefix}-cae-hyb-{env}",
        "nsgCaeHybCell": f"nsg-{prefix}-cae-hyb-{env}-c02",
        "platformJobKvsetExtCell01": f"caj-{prefix}-kvset-ext",
        "platformJobKvsetExtCell": f"caj-{prefix}-kvset-ext-c02",
        "platformJobDbinitHybCell": f"caj-{prefix}-dbinit-hyb-c02",
        "platformJobIdentityRecov": f"id-{prefix}-recov-{env}",
        "provisioningIdentity": f"id-{prefix}-provisioning-{env}",
        "entraProvisioningIdentity": f"id-{prefix}-entra-provisioning",
        "adoAutomationIdentity": f"id-{prefix}-ado-automation",
        "portalIdentity": f"id-{prefix}-portal",
        "identitiesResourceGroup": f"rg-{prefix}-identities-{env}",
        "identitiesLock": f"lock-{prefix}-identities-readonly",
        "entraResourceGroup": f"rg-{prefix}-entra",
        "entraEnvironmentResourceGroup": f"rg-{prefix}-entra-{env}",
        "entraAuditAlertTier0": f"alert-{prefix}-entra-tier0",
        "entraAuditAlertConsent": f"alert-{prefix}-entra-consent",
        "provisioningServiceConnection": f"sc-platform-provisioning-{env}",
        "instanceServiceConnection": "sc-platform-ado",
        "entraServiceConnection": "sc-platform-entra",
        "backupVault": f"bvault-{prefix}-{env}",
        "frontDoorProfile": f"afd-{prefix}-{env}",
        "frontDoorEndpoint": f"fde-{prefix}-{env}",
        "frontDoorWafPolicy": f"waf{prefix}{env}",
        "frontDoorSecurityPolicy": f"secp-{prefix}-{env}",
        "frontDoorPortalOriginGroup": f"og-portal-{env}",
        "frontDoorPortalOrigin": f"orig-portal-{env}",
        "frontDoorPortalRoute": f"route-portal-{env}",
        "platformDeployment": f"platform-{prefix}-{env}",
        "portalDeployment": f"portal-{prefix}-{env}",
        "appDeployerRoleName": f"App Deployer ({prefix})",
        "appEnvironmentJoinerRoleName": f"App Environment Joiner ({prefix})",
        "entraDeploymentOperatorRoleName": f"Entra Deployment Operator ({prefix})",
        "platformJobSecretWriterRoleName": f"Platform Job Secret Writer ({prefix})",
        # app
        "appResourceGroup": f"rg-{prefix}-app-{slug}-{env}",
        "slugCompact": sc,
        "hash6": "{h6}",
        "containerApp": f"ca-{slug}",
        "containerAppJob": f"caj-{slug}-{job}",
        "runtimeIdentity": f"id-{prefix}-{slug}-run-{env}",
        "deliveryIdentity": f"id-{prefix}-{slug}-deploy-{env}",
        "easyAuthIdentity": f"id-{prefix}-{slug}-auth-{env}",
        "deliveryFederatedCredential": f"fic-ado-{slug}-{env}",
        "containerRegistry": f"cr{prefix}{sc}{env}{{h6}}",
        "appKeyVault": f"kv{sc[:16]}{{h6}}",
        "appKeyVaultNextGeneration": f"kv{sc[:16]}{{h6next}}",
        "storageAccount": f"st{sc[:16]}{{h6}}",
        "postgresServer": f"pgsql-{prefix}-{slug}-{env}-{{h6}}",
        "postgresDatabase": slug.replace("-", "_"),
        "sqlServer": f"sql-{prefix}-{slug}-{env}-{{h6}}",
        "sqlDatabase": f"sqldb-{slug}",
        "pepPostgres": f"pep-pgsql-{prefix}-{slug}-{env}-{{h6}}",
        "pepVault": f"pep-kv{sc[:16]}{{h6}}",
        "pepSql": f"pep-sql-{prefix}-{slug}-{env}-{{h6}}",
        "pepVaultPortal": f"pep-kv{sc[:16]}{{h6}}-portal",
        "pepStorageBlob": f"pep-st{sc[:16]}{{h6}}-blob",
        "pepStorageBlobNic": f"nic-pep-st{sc[:16]}{{h6}}-blob",
        "applicationInsights": f"appi-{slug}-{env}",
        "actionGroup": f"ag-{slug}-{env}",
        "actionGroupShortName": f"{sc[:7]}-{env[:4]}",
        "metricAlertRestarts": f"alert-{slug}-restarts-{env}",
        "metricAlertPgCredits": f"alert-{slug}-pgcredits-{env}",
        "budget": f"budget-{slug}-{env}",
        "registryRepository": slug,
        "easyAuthSecret": f"easyauth-{slug}",
        "frontDoorOriginGroup": f"og-{slug}-{env}",
        "frontDoorOrigin": f"orig-{slug}-{env}",
        "frontDoorRoute": f"route-{slug}-{env}",
        "frontDoorCustomDomain": "cd-" + host.replace(".", "-"),
        "frontDoorValidationRecord": f"_dnsauth.{host}",
        # Every test host is in the zone contoso.com (the default dnsZone of naming.tests.bicep).
        "dnsHostRecord": host.removesuffix(".contoso.com"),
        "dnsValidationRecord": "_dnsauth." + host.removesuffix(".contoso.com"),
        "provisioningDeployment": f"lz-{slug}-{env}",
        "releaseDeployment": f"release-{slug}",
        "frontDoorDeployment": f"fd-{slug}-{env}",
        "entraDeployment": f"entra-{slug}-{env}",
        "entraApplicationUniqueName": f"{prefix}-{slug}-{env}" + (f"--i{incarnation}" if incarnation else ""),
        "portalEntraApplicationUniqueName": f"{prefix}-portal-{env}",
        "portalEntraDeployment": f"entra-portal-{env}",
        "portalEndpointDeployment": f"pep-portal-{slug}-{env}",
        "adoServiceConnection": f"sc-{slug}-{env}",
        "adoEnvironment": f"{slug}-{env}",
        "adoDeliveryPipeline": f"delivery-{slug}",
        "adoPlatformPipeline": f"platform-{env}",
        "adoPlatformEnvironment": f"platform-{env}",
    }


# Azure limits and character rules per name (Microsoft Learn resource-name rules, ADR-0020).
LOWER_ALNUM = r"[a-z0-9]"
RULES: dict[str, tuple[int, int, str]] = {
    # key: (min, max, regex the whole name must match)
    "platformResourceGroup": (1, 90, r"[-\w.()]*[-\w()]"),
    "privateDnsResourceGroupExt": (1, 90, r"[-\w.()]*[-\w()]"),
    "privateDnsResourceGroupHyb": (1, 90, r"[-\w.()]*[-\w()]"),
    "appResourceGroup": (1, 90, r"[-\w.()]*[-\w()]"),
    "identitiesResourceGroup": (1, 90, r"[-\w.()]*[-\w()]"),
    "entraResourceGroup": (1, 90, r"[-\w.()]*[-\w()]"),
    "entraEnvironmentResourceGroup": (1, 90, r"[-\w.()]*[-\w()]"),
    "portalResourceGroup": (1, 90, r"[-\w.()]*[-\w()]"),
    "identitiesLock": (1, 90, r"[^<>*%&:\\?.+/]*[^<>*%&:\\?.+/ ]"),
    # Federated credential names (the service connection name): 3-120, [a-zA-Z0-9-_], starting alphanumeric.
    "provisioningServiceConnection": (3, 120, r"[a-zA-Z0-9][\w-]*"),
    "instanceServiceConnection": (3, 120, r"[a-zA-Z0-9][\w-]*"),
    "entraServiceConnection": (3, 120, r"[a-zA-Z0-9][\w-]*"),
    "logAnalyticsWorkspace": (4, 63, r"[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]"),
    "platformActionGroupShortName": (1, 12, r".+"),
    "actionGroupShortName": (1, 12, r".+"),
    "caeExt": (2, 32, r"[a-z][a-z0-9-]*[a-z0-9]"),
    "caeHyb": (2, 32, r"[a-z][a-z0-9-]*[a-z0-9]"),
    "caeInt": (2, 32, r"[a-z][a-z0-9-]*[a-z0-9]"),
    "caePortal": (2, 32, r"[a-z][a-z0-9-]*[a-z0-9]"),
    "vnetPortal": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "snetCaePortal": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "snetPepPortal": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "nsgCaePortal": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "nsgPepPortal": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "natGatewayPortal": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "natPublicIpPortal01": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "dnsZoneLinkPortal": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "vnetExt": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "vnetHyb": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "snetCaeExt": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "snetPepHyb": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "nsgCaeHyb": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "nsgPepExt": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "natGatewayExt": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "natPublicIp16": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "hubPeeringHyb": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "envVaultPublic": (3, 24, r"[a-z][a-z0-9]*"),
    "envVaultPrivate": (3, 24, r"[a-z][a-z0-9]*"),
    "appKeyVault": (3, 24, r"[a-z][a-z0-9]*"),
    "appKeyVaultNextGeneration": (3, 24, r"[a-z][a-z0-9]*"),
    "storageAccount": (3, 24, r"[a-z0-9]+"),
    "containerRegistry": (5, 50, r"[a-zA-Z0-9]+"),
    "platformRegistry": (5, 50, r"[a-zA-Z0-9]+"),
    "containerApp": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "containerAppJob": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "portalContainerApp": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "platformJobDbinitExt": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "platformJobKvsetExt": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "platformJobKvsetHyb": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "caeExtCell": (2, 32, r"[a-z][a-z0-9-]*[a-z0-9]"),
    "caeHybCell": (2, 32, r"[a-z][a-z0-9-]*[a-z0-9]"),
    "snetCaeHybCell": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "nsgCaeHybCell": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "platformJobKvsetExtCell": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "platformJobDbinitHybCell": (2, 31, r"[a-z](?!.*--)[a-z0-9-]*[a-z0-9]"),
    "runtimeIdentity": (3, 128, r"[a-zA-Z0-9][\w-]*"),
    "deliveryIdentity": (3, 128, r"[a-zA-Z0-9][\w-]*"),
    "easyAuthIdentity": (3, 128, r"[a-zA-Z0-9][\w-]*"),
    "deliveryFederatedCredential": (3, 120, r"[a-zA-Z0-9][\w-]{2,119}"),
    "postgresServer": (3, 63, r"[a-z0-9]+(-[a-z0-9]+)*"),
    "portalPostgresServer": (3, 63, r"[a-z0-9]+(-[a-z0-9]+)*"),
    "pepPortalPostgres": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "sqlServer": (1, 63, r"[a-z0-9]([a-z0-9-]*[a-z0-9])?"),
    "portalSqlServer": (1, 63, r"[a-z0-9]([a-z0-9-]*[a-z0-9])?"),
    "pepPortalSql": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "pepPostgres": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "pepSql": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "pepVaultPortal": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "pepStorageBlob": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "envVaultPrivatePepHyb": (2, 64, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "pepStorageBlobNic": (1, 80, r"[a-zA-Z0-9][\w.-]*[\w]"),
    "budget": (1, 63, r"[\w-]+"),
    "frontDoorWafPolicy": (1, 128, r"[a-zA-Z][a-zA-Z0-9]*"),
    "frontDoorEndpoint": (1, 46, r"[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]"),
    "frontDoorPortalOriginGroup": (1, 90, r"[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]"),
    "frontDoorPortalOrigin": (1, 90, r"[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]"),
    "frontDoorPortalRoute": (1, 90, r"[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]"),
    # A DNS name has at most 253 characters; the record set names are relative to the zone.
    "frontDoorValidationRecord": (1, 253, r"_dnsauth(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+"),
    "dnsHostRecord": (1, 253, r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*"),
    "dnsValidationRecord": (1, 253, r"_dnsauth(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+"),
    "frontDoorDeployment": (1, 64, r"[-\w.()]+"),
    "provisioningDeployment": (1, 64, r"[-\w.()]+"),
    "releaseDeployment": (1, 64, r"[-\w.()]+"),
    "entraDeployment": (1, 64, r"[-\w.()]+"),
    "portalEntraDeployment": (1, 64, r"[-\w.()]+"),
    "portalEndpointDeployment": (1, 64, r"[-\w.()]+"),
    "platformDeployment": (1, 64, r"[-\w.()]+"),
    "portalDeployment": (1, 64, r"[-\w.()]+"),
    "easyAuthSecret": (1, 127, r"[0-9a-zA-Z-]+"),
}


def to_regex(template: str, hashes: dict[str, str]) -> re.Pattern[str]:
    pattern = re.escape(template)
    for key, length in (("h6next", 6), ("h6p", 6), ("h6d", 6), ("h6", 6), ("h5", 5)):
        token = re.escape("{" + key + "}")
        if key in hashes:
            pattern = pattern.replace(token, re.escape(hashes[key]))
        else:
            pattern = pattern.replace(token, f"(?P<{key}>{HASH}{{{length}}})", 1).replace(
                token, f"(?P={key})")
    return re.compile(pattern + r"\Z")


def check_case(case: dict) -> None:
    inp = case["input"]
    names = {**case["platform"], **case["app"]}
    label = f"[{inp['prefix']}/{inp['env']}/{inp['slug']}]"
    exp = expected(inp["prefix"], inp["env"], inp["slug"], inp["jobKey"], inp["host"], inp.get("incarnation", 0))

    h6 = names["hash6"]
    check(re.fullmatch(f"{HASH}{{6}}", h6) is not None, f"{label} h6 '{h6}' isn't 6 x [a-z0-9]")
    for key, template in exp.items():
        actual = names.get(key)
        if actual is None:
            failures.append(f"{label} missing output '{key}'")
            continue
        hashes = {"h6": h6} if "{h6}" in template else {}
        rx = to_regex(template, hashes)
        check(rx.match(actual) is not None, f"{label} {key}: expected '{template}', got '{actual}'")

    for key, (lo, hi, charset) in RULES.items():
        value = names[key]
        check(lo <= len(value) <= hi, f"{label} {key} '{value}' has {len(value)} characters, allowed {lo}-{hi}")
        check(re.fullmatch(charset, value) is not None, f"{label} {key} '{value}' violates {charset}")

    # Environment vaults: variant letter, distinct names, 24-character limit, generation bump.
    check(names["envVaultPublic"] != names["envVaultPrivate"], f"{label} public and private vault share a name")
    check(names["envVaultPrivate"] != names["envVaultPrivateNextGeneration"],
          f"{label} vaultGeneration bump doesn't change the private vault name")
    check(names["appKeyVault"] != names["appKeyVaultNextGeneration"],
          f"{label} generation bump doesn't change the app vault name")
    # Platform registry (ADR-0035): never an app registry name. For the same prefix and
    # environment the app registry is longer by the slug; its hash has its own seed.
    platform_registry, app_registry = names["platformRegistry"], names["containerRegistry"]
    check(platform_registry != app_registry and len(platform_registry) < len(app_registry),
          f"{label} platform registry '{platform_registry}' must be shorter than and differ from the app registry '{app_registry}'")
    check(not platform_registry.endswith(h6), f"{label} platform registry '{platform_registry}' reuses the app hash {h6}")
    for key in ("envVaultPublic", "envVaultPrivate"):
        check(len(names[key]) <= 24, f"{label} {key} '{names[key]}' exceeds 24")
    # Portal (ADR-0036, ADR-0025): its own RG, CAE and network, never equal to a network mode's
    # names or the platform RG of the same environment.
    portal_keys = ("portalResourceGroup", "caePortal", "vnetPortal", "snetCaePortal", "snetPepPortal", "nsgCaePortal",
                   "nsgPepPortal", "natGatewayPortal", "natPublicIpPortal01")
    other_keys = ("platformResourceGroup", "privateDnsResourceGroupExt", "privateDnsResourceGroupHyb", "caeExt", "caeHyb",
                  "caeInt", "vnetExt", "vnetHyb", "snetCaeExt", "snetPepHyb", "nsgCaeHyb", "nsgPepExt", "natGatewayExt",
                  "natPublicIp01", "identitiesResourceGroup", "appResourceGroup")
    clashes = {k for k in portal_keys if names[k] in {names[o] for o in other_keys}}
    check(not clashes, f"{label} portal names equal other names: {sorted(clashes)}")
    # Capacity cells (ADR-0053): cell 01 keeps today's names (nothing existing is renamed); a later
    # cell's CAE, subnet, NSG and jobs differ from every existing name of the environment.
    for cell01, today in (("caeExtCell01", "caeExt"), ("snetCaeExtCell01", "snetCaeExt"), ("nsgCaeHybCell01", "nsgCaeHyb"),
                          ("platformJobKvsetExtCell01", "platformJobKvsetExt")):
        check(names[cell01] == names[today], f"{label} cell 01 renames {today}: '{names[today]}' -> '{names[cell01]}'")
    later = ("caeExtCell", "caeHybCell", "snetCaeHybCell", "nsgCaeHybCell", "platformJobKvsetExtCell", "platformJobDbinitHybCell")
    existing = {names[o] for o in (*other_keys, *portal_keys, "platformJobKvsetExt", "platformJobKvsetHyb", "platformJobDbinitExt")}
    clashes = {k for k in later if names[k] in existing}
    check(not clashes and len({names[k] for k in later}) == len(later), f"{label} later-cell names equal existing names: {sorted(clashes)}")
    # Entra records per environment (ADR-0063): rg-{prefix}-entra-{env} sits in the portal host
    # environment's subscription next to the instance's rg-{prefix}-entra and the host's own groups;
    # it never equals any of them.
    rg_keys = ("entraResourceGroup", "platformResourceGroup", "privateDnsResourceGroupExt", "privateDnsResourceGroupHyb",
               "identitiesResourceGroup", "portalResourceGroup", "appResourceGroup")
    check(names["entraEnvironmentResourceGroup"] not in {names[k] for k in rg_keys},
          f"{label} entraEnvironmentResourceGroup '{names['entraEnvironmentResourceGroup']}' equals another resource group name")
    check(names["portalContainerApp"] != names["containerApp"], f"{label} portal Container App equals the app's")
    # The portal's Front Door objects (ADR-0071) share the profile with the apps' and never take an app's name.
    for portal_key, app_key in (("frontDoorPortalOriginGroup", "frontDoorOriginGroup"), ("frontDoorPortalOrigin", "frontDoorOrigin"),
                                ("frontDoorPortalRoute", "frontDoorRoute")):
        check(names[portal_key] != names[app_key], f"{label} {portal_key} '{names[portal_key]}' equals the app's {app_key}")
    check(names["portalPostgresServer"] != names["postgresServer"] and not names["portalPostgresServer"].endswith(h6),
          f"{label} portal PostgreSQL server '{names['portalPostgresServer']}' equals or shares the hash of the app's")
    check(names["portalSqlServer"] != names["sqlServer"] and not names["portalSqlServer"].endswith(h6),
          f"{label} portal Azure SQL server '{names['portalSqlServer']}' equals or shares the hash of the app's")
    # Front Door (ADR-0010, amended 2026-11-01): the record names put the host back together within
    # its zone.
    check(f"{names['dnsHostRecord']}.contoso.com" == inp["host"]
          and names["dnsValidationRecord"] == f"_dnsauth.{names['dnsHostRecord']}",
          f"{label} DNS record names {names['dnsHostRecord']} / {names['dnsValidationRecord']} don't match host {inp['host']}")
    # Portal-side vault endpoint (ADR-0025): its deployment in the portal RG never equals the portal's
    # own deployment or an app deployment name.
    check(names["portalEndpointDeployment"] not in {names[k] for k in ("portalDeployment", "provisioningDeployment",
                                                                        "releaseDeployment", "entraDeployment",
                                                                        "frontDoorDeployment", "portalEntraDeployment")},
          f"{label} portalEndpointDeployment '{names['portalEndpointDeployment']}' equals another deployment name")
    check(names["portalEntraApplicationUniqueName"] != names["entraApplicationUniqueName"]
          and names["portalEntraDeployment"] != names["entraDeployment"],
          f"{label} portal registration uniqueName or deployment equals the app's")
    # Entra uniqueName per incarnation (ADR-0061): `--` only above incarnation 0, never in a first
    # incarnation's name (slug and environment names have no `--`), so the two can't be equal.
    unique_name, incarnation = names["entraApplicationUniqueName"], inp.get("incarnation", 0)
    check(("--" in unique_name) == (incarnation > 0) and unique_name.startswith(f"{inp['prefix']}-{inp['slug']}-{inp['env']}"),
          f"{label} entraApplicationUniqueName '{unique_name}' for incarnation {incarnation}")
    # Custom role definition GUIDs: GUID shape, one per role.
    roles = [names[k] for k in CUSTOM_ROLE_KEYS]
    for key, value in zip(CUSTOM_ROLE_KEYS, roles):
        check(GUID.fullmatch(value) is not None, f"{label} {key} '{value}' isn't a GUID")
    check(len(set(roles)) == len(roles), f"{label} custom role definition GUIDs are not distinct: {roles}")
    # Display name rule: env suffix outside prod.
    want_display = "Hotel Inventory" if inp["envKind"] == "prod" else f"Hotel Inventory ({inp['env']})"
    check(names["entraApplicationDisplayName"] == want_display,
          f"{label} entraApplicationDisplayName '{names['entraApplicationDisplayName']}' != '{want_display}'")


def check_custom_role_guids(cases: list[dict]) -> None:
    """Custom role GUIDs depend on tenant and prefix only: same prefix -> same GUID, other prefix -> other GUID."""
    for key in CUSTOM_ROLE_KEYS:
        by_prefix: dict[str, set[str]] = {}
        for case in cases:
            by_prefix.setdefault(case["input"]["prefix"], set()).add(case["platform"].get(key, ""))
        check(all(len(v) == 1 for v in by_prefix.values()), f"{key}: GUID differs within one prefix: {by_prefix}")
        values = [next(iter(v)) for v in by_prefix.values()]
        check(len(set(values)) == len(values), f"{key}: two prefixes share a GUID: {by_prefix}")


def is_max_case(inp: dict) -> bool:
    return len(inp["prefix"]) == 8 and len(inp["env"]) == 8 and len(inp["slug"]) == 20 and len(inp["jobKey"]) == 6


def bicep_literal(value: object) -> str:
    """Render a Python value as a Bicep literal (single-quoted strings, unquoted keys)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if isinstance(value, list):
        return "[\n" + "\n".join(bicep_literal(v) for v in value) + "\n]"
    if isinstance(value, dict):
        return "{\n" + "\n".join(f"{k}: {bicep_literal(v)}" for k, v in value.items()) + "\n}"
    raise TypeError(type(value))


def param_text(cases: list[dict]) -> str:
    return "using 'naming.tests.bicep'\n\nparam cases = " + bicep_literal(cases) + "\n"


def load_vectors() -> dict:
    return json.loads(VECTORS.read_text())


def write_vectors(vectors: dict, cases: list[dict]) -> None:
    """--update-vectors: take the exact names from naming.bicep's own output (review the diff)."""
    for vector, case in zip(vectors["cases"], cases):
        vector["names"] = {**case["platform"], **case["app"]}
    VECTORS.write_text(json.dumps(vectors, indent=2, ensure_ascii=False) + "\n")
    print(f"updated {VECTORS.relative_to(REPO)} from the Bicep output")


def check_vectors(vectors: dict, cases: list[dict]) -> None:
    """Every name naming.bicep computes equals the shared vector, and the vector has no other name."""
    check(len(cases) == len(vectors["cases"]), f"{len(cases)} snapshot cases for {len(vectors['cases'])} vectors")
    for vector, case in zip(vectors["cases"], cases):
        inp = vector["input"]
        label = f"[vectors {inp['prefix']}/{inp['env']}/{inp['slug']}]"
        actual = {**case["platform"], **case["app"]}
        want = vector["names"]
        check(sorted(actual) == sorted(want),
              f"{label} name keys differ: only in Bicep {sorted(set(actual) - set(want))}, only in vectors {sorted(set(want) - set(actual))}")
        for key in sorted(set(actual) & set(want)):
            check(actual[key] == want[key], f"{label} {key}: naming.bicep gives '{actual[key]}', the vector says '{want[key]}'")


def confusable_cases(vectors: dict) -> list[dict]:
    """The inputs of the confusable pairs, a and b of each pair in turn."""
    out = []
    for pair in vectors["confusable"]["pairs"]:
        out += [{**vectors["base"], **pair["a"]}, {**vectors["base"], **pair["b"]}]
    return out


def check_confusable(vectors: dict, cases: list[dict]) -> list[str]:
    """Injectivity (ADR-0052): for each pair of confusable apps, exactly the listed names collide. Names
    that differ only through the app hash h6 are reported (they are apart because the hash of the app
    resource group name is), not failed. Returns the names that rely on the hash."""
    conf = vectors["confusable"]
    independent = set(conf["independent"])
    known = set(conf["knownNonInjective"])
    pairs = conf["pairs"]
    check(len(cases) == 2 * len(pairs), f"confusable: {len(cases)} snapshot cases for {len(pairs)} pairs")
    hashed: set[str] = set()
    for i, pair in enumerate(pairs):
        if 2 * i + 1 >= len(cases):
            break
        a, b = cases[2 * i]["app"], cases[2 * i + 1]["app"]
        label = f"[confusable '{pair['label']}']"
        check(a["appResourceGroup"] != b["appResourceGroup"], f"{label} both apps have the resource group {a['appResourceGroup']}")
        collide = {k for k in a if k not in independent and a[k] == b.get(k)}
        want = set(pair["collisions"])
        check(collide == want, f"{label} names that collide: {sorted(collide)}, expected {sorted(want)} "
                               f"(a new collision lets one app's deployment write another's resource; fix the name, or "
                               f"guard it and list it in knownNonInjective with the reason)")
        check(want <= known, f"{label} collisions without a reason in knownNonInjective: {sorted(want - known)}")
        ha, hb = a["hash6"], b["hash6"]
        check(ha != hb, f"{label} both apps have the hash {ha}")
        for k in a:
            if k not in independent | {"hash6"} and k not in collide and ha in a[k] and a[k].replace(ha, "{h6}") == b[k].replace(hb, "{h6}"):
                hashed.add(k)
    unused = known - {k for p in pairs for k in p["collisions"]}
    check(not unused, f"confusable: knownNonInjective lists names no pair shows colliding: {sorted(unused)}")
    return sorted(hashed)


def main() -> int:
    update = "--update-vectors" in sys.argv[1:]
    vectors = load_vectors()
    with tempfile.TemporaryDirectory(prefix="saf-naming-") as tmp:
        work = Path(tmp)
        (work / "infra" / "modules" / "naming").mkdir(parents=True)
        (work / "infra" / "tests").mkdir(parents=True)
        shutil.copy(NAMING, work / "infra" / "modules" / "naming" / "naming.bicep")
        shutil.copy(TESTS, work / "infra" / "tests" / "naming.tests.bicep")
        shutil.copy(REPO / "bicepconfig.json", work / "bicepconfig.json")

        # 1. compile
        az_build(NAMING, work / "out")
        az_build(TESTS, work / "out")

        # 2./3./4. positive matrix: the inputs of the shared vectors
        rc, data, log = snapshot(work, param_text([c["input"] for c in vectors["cases"]]))
        if rc != 0 or data is None:
            failures.append(f"snapshot of the naming vectors failed:\n{log[:2000]}")
        else:
            cases = data["outputs"]["names"]
            if update:
                write_vectors(vectors, cases)
            check(any(is_max_case(c["input"]) for c in cases), "no maximum-length case in the matrix")
            for case in cases:
                check_case(case)
            check_custom_role_guids(cases)
            check_vectors(vectors, cases)
            print(f"positive cases: {len(cases)} evaluated, every name compared with {VECTORS.name}")

        # 6. injectivity over confusable app pairs (ADR-0052)
        rc, data, log = snapshot(work, param_text(confusable_cases(vectors)))
        if rc != 0 or data is None:
            failures.append(f"snapshot of the confusable pairs failed:\n{log[:2000]}")
        else:
            hashed = check_confusable(vectors, data["outputs"]["names"])
            print(f"confusable pairs: {len(vectors['confusable']['pairs'])} evaluated; non-injective by design: "
                  f"{', '.join(sorted(vectors['confusable']['knownNonInjective']))}; apart only through h6: {', '.join(hashed)}")

        # 5. negative cases: each must fail with a naming: message
        for entry in vectors["invalid"]:
            rc, _, log = snapshot(work, param_text([{**vectors["base"], **entry["override"]}]))
            check(rc != 0 and "naming:" in log, f"negative case '{entry['label']}' did not fail with a naming: error")
        print(f"negative cases: {len(vectors['invalid'])} evaluated")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("all naming checks passed")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("AZURE_CORE_ONLY_SHOW_ERRORS", "true")
    sys.exit(main())
