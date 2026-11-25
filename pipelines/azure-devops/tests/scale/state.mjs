// state.mjs — the fake Azure state of check-prov-scale.sh (ADR-0050): every app of plan/apps.json
// provisioned and recorded, as the lists plan.sh reads would return it, pre-paged with nextLink like
// ARM. Offline, no Azure. Usage:
//   node state.mjs <apps.json> <unit-inputs.json> <images.json> <out dir> <now epoch> [<slug whose Easy Auth rotation is due>] [purge] [<slug that moves>]
// The landing zones carry the registry purge's outputs (ADR-0059: the registry, the purge role in the build
// environment nonprod) and every nonprod group a purge 3 days old; with `purge`, no group has one (every app
// is due). Every Container App runs in the External-only CAE of its environment; the app that moves (ADR-0060)
// runs in nonprod's hybrid CAE, while app.yaml says External only (a network mode change, case A there).
// The Entra records (ADR-0063): those of nonprod still in the instance's rg-contoso-entra (deployed before
// ADR-0063; its records group rg-contoso-entra-nonprod exists and is empty), those of prod in
// rg-contoso-entra-prod; the instance's group also holds entra-permissions.
// Writes <out>/groups.json, lz.json, entra.json (rg-contoso-entra), entra-<env>.json (rg-contoso-entra-<env>),
// fd.json and <out>/pages/<list>-<n>.json, plus <out>/sub.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [appsFile, inputsFile, imagesFile, out, nowArg, dueSlug, purgeArg, moveSlug] = process.argv.slice(2);
const apps = JSON.parse(readFileSync(appsFile, "utf8")).apps.filter((a) => a.ok);
const inputs = JSON.parse(readFileSync(inputsFile, "utf8"));
const jobsDigest = JSON.parse(readFileSync(imagesFile, "utf8")).images["saf-jobs"].digest;
const now = Number(nowArg);
const SUB = "00000000-0000-0000-0000-00000000a001";
const ARM = "https://management.azure.com";
const PREFIX = "contoso";
const VERSION = inputs.coreVersion;
const day = (offset) => new Date((now + offset * 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
mkdirSync(join(out, "pages"), { recursive: true });
writeFileSync(join(out, "sub"), SUB);

// pages(<list key>, <ARM path>, items, size): page n holds items [n*size, (n+1)*size), nextLink to n+1.
function pages(key, path, items, size) {
  const n = Math.max(1, Math.ceil(items.length / size));
  for (let i = 0; i < n; i++) {
    const page = { value: items.slice(i * size, (i + 1) * size) };
    if (i + 1 < n) page.nextLink = `${ARM}${path}?api-version=2024-03-01&$skipToken=${i + 1}`;
    writeFileSync(join(out, "pages", `${key}-${i}.json`), JSON.stringify(page));
  }
}

const groups = [];
const lz = [];
const entra = [{ name: "entra-permissions", state: "Succeeded", timestamp: "2026-01-01T00:00:00.0000000Z" }];
const entraByEnv = {};
const containerApps = [];
const secrets = {};
const envs = new Set();
for (const a of apps) {
  const want = inputs.apps[a.slug];
  for (const env of a.environments) {
    envs.add(env);
    const rg = `rg-${PREFIX}-app-${a.slug}-${env}`;
    const tags = {};
    for (const [unit, i] of Object.entries({ ...want.environments[env], ado: want.ado })) {
      if (unit === "frontdoor" || !i) continue;
      tags[`saf-u-${unit}`] = `${VERSION} ${i.slice(0, 12)} ${day(-3)}`;
    }
    tags["saf-u-files"] = want.files.slice(0, 12);
    if (env === "nonprod" && purgeArg !== "purge") tags["saf-registry-purge"] = `${day(-3)} purge`;
    groups.push({ name: rg, tags });
    const vault = `kv-${PREFIX}-${env}`;
    lz.push({
      name: `lz-${a.slug}-${env}`,
      properties: {
        provisioningState: "Succeeded",
        templateHash: "1",
        parameters: { environmentName: { value: env }, deliveryFederation: { value: { issuer: "https://vstoken.example", subject: `sc-${a.slug}-${env}` } }, easyAuthSecretExists: { value: true }, networkMode: { value: "externalOnly" } },
        outputs: {
          environmentKeyVaultName: { value: vault },
          containerAppFqdn: { value: `ca-${a.slug}.${env}.example.io` },
          resourceGroupName: { value: rg },
          registryName: { value: `cr${PREFIX}${a.slug.replace(/-/g, "")}${env}1a2b3c` },
          registryPurgeRole: { value: env === "nonprod" },
        },
      },
    });
    const record = { name: `entra-${a.slug}-${env}`, state: "Succeeded", timestamp: "2026-10-01T00:00:00.0000000Z" };
    if (env === "nonprod") entra.push(record);
    else (entraByEnv[env] ??= []).push(record);
    const due = a.slug === dueSlug;
    const created = due ? now - 100 * 86400 : now - 10 * 86400;
    const exp = created + 180 * 86400;
    (secrets[vault] ??= []).push({ name: `easyauth-${a.slug}`, properties: { attributes: { enabled: true, created, exp } } });
    // Half the apps carry the tag saf-easyauth, the other half a later modification (a delivery).
    const even = (apps.indexOf(a) % 2) === 0;
    containerApps.push({
      // As ARM's list answers: the type segment in lower case (containerapps), unlike templates.
      id: `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/containerapps/ca-${a.slug}`,
      name: `ca-${a.slug}`,
      tags: even ? { "saf-easyauth": String(created) } : {},
      systemData: { lastModifiedAt: iso(created + 3600) },
      properties: {
        environmentId: `/subscriptions/${SUB}/resourceGroups/rg-${PREFIX}-platform-${env}/providers/Microsoft.App/managedEnvironments/cae-${PREFIX}-${a.slug === moveSlug && env === "nonprod" ? "hyb" : "ext"}-${env}`,
        configuration: { ingress: { fqdn: `ca-${a.slug}.${env}.example.io`, ipSecurityRestrictions: [] } },
        template: { containers: [{ image: `cr.example.io/${a.slug}@sha256:${"0".repeat(64)}` }] },
      },
    });
    pages(`rev-ca-${a.slug}-${env}`, `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/ca-${a.slug}/revisions`,
      [{ name: `ca-${a.slug}--r1`, properties: { active: true, createdTime: iso(created + 7200) } }], 20);
  }
}
writeFileSync(join(out, "groups.json"), JSON.stringify(groups));
writeFileSync(join(out, "lz.json"), JSON.stringify(lz));
writeFileSync(join(out, "entra.json"), JSON.stringify(entra));
for (const env of envs) writeFileSync(join(out, `entra-${env}.json`), JSON.stringify(entraByEnv[env] ?? []));
writeFileSync(join(out, "fd.json"), "[]");
pages("ca", `/subscriptions/${SUB}/providers/Microsoft.App/containerApps`, containerApps, 100);
for (const env of envs) {
  pages(`jobs-${env}`, `/subscriptions/${SUB}/resourceGroups/rg-${PREFIX}-platform-${env}/providers/Microsoft.App/jobs`,
    [{ id: `/subscriptions/${SUB}/resourceGroups/rg-${PREFIX}-platform-${env}/providers/Microsoft.App/jobs/caj-${PREFIX}-kvset-ext`, properties: { template: { containers: [{ image: `registry.example/saf-jobs@${jobsDigest}` }] } } }], 100);
}
for (const [vault, list] of Object.entries(secrets)) {
  const env = vault.replace(`kv-${PREFIX}-`, "");
  pages(`secrets-${vault}`, `/subscriptions/${SUB}/resourceGroups/rg-${PREFIX}-platform-${env}/providers/Microsoft.KeyVault/vaults/${vault}/secrets`, list, 25);
}
