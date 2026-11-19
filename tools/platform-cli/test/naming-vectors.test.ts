import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as names from "../src/ado/names.js";
import * as fd from "../src/provisioning/frontdoor-plan.js";
import * as pn from "../src/provisioning/names.js";
import { frontDoorCustomDomainName } from "../src/validate-app.js";
import { REPO_ROOT } from "./helpers.js";

/**
 * src/ado/names.ts against the shared naming test vectors (infra/tests/naming-vectors.json, ADR-0020,
 * US03.02). infra/tests/check-naming.py evaluates naming.bicep for the same inputs and compares every
 * name with the same file, so the names the CLI computes equal the Bicep module's.
 */
interface Input {
  prefix: string;
  env: string;
  slug: string;
  [field: string]: unknown;
}
interface Vectors {
  base: Input;
  cases: { input: Input; names: Record<string, string> }[];
  invalid: { label: string; override: Record<string, unknown> }[];
  confusable: { pairs: { label: string; a: Partial<Input>; b: Partial<Input>; collisions: string[] }[] };
}

const vectors = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "tests", "naming-vectors.json"), "utf8")) as Vectors;

/** Each name function of names.ts with the vector key it must reproduce. */
const PORTED: { key: string; fn: unknown; run: (i: Input) => string }[] = [
  { key: "adoServiceConnection", fn: names.adoServiceConnection, run: (i) => names.adoServiceConnection(i.slug, i.env) },
  { key: "adoEnvironment", fn: names.adoEnvironment, run: (i) => names.adoEnvironment(i.slug, i.env) },
  { key: "adoDeliveryPipeline", fn: names.adoDeliveryPipeline, run: (i) => names.adoDeliveryPipeline(i.slug) },
  { key: "adoPlatformPipeline", fn: names.adoPlatformPipeline, run: (i) => names.adoPlatformPipeline(i.env) },
  { key: "adoPlatformEnvironment", fn: names.adoPlatformEnvironment, run: (i) => names.adoPlatformEnvironment(i.env) },
  { key: "identitiesResourceGroup", fn: names.identitiesResourceGroup, run: (i) => names.identitiesResourceGroup(i.prefix, i.env) },
  { key: "identitiesLock", fn: names.identitiesLock, run: (i) => names.identitiesLock(i.prefix) },
  { key: "provisioningServiceConnection", fn: names.provisioningServiceConnection, run: (i) => names.provisioningServiceConnection(i.env) },
  // The instance service connection for the default purpose ado, and for entra (vector keys instanceServiceConnection and entraServiceConnection).
  { key: "instanceServiceConnection", fn: names.instanceServiceConnection, run: () => names.instanceServiceConnection("ado") },
];

describe("names.ts against the shared naming vectors", () => {
  it("every name function of names.ts is in the table", () => {
    const exported = Object.values(names).filter((v) => typeof v === "function");
    for (const fn of exported) assert.ok(PORTED.some((p) => p.fn === fn), `${(fn as { name: string }).name} has no vector`);
  });

  for (const c of vectors.cases) {
    it(`${c.input.prefix}/${c.input.env}/${c.input.slug}: every name equals the vector`, () => {
      for (const p of PORTED) assert.equal(p.run(c.input), c.names[p.key], p.key);
      assert.equal(names.instanceServiceConnection("entra"), c.names.entraServiceConnection);
    });
  }

  it("rejects the instance service connection purposes the vectors list as invalid", () => {
    const purposes = vectors.invalid.map((v) => v.override.scPurpose).filter((p): p is string => typeof p === "string");
    assert.ok(purposes.length >= 2);
    for (const purpose of purposes) assert.throws(() => names.instanceServiceConnection(purpose as "ado"), /unknown purpose/, purpose);
  });
});

/**
 * The Front Door names provisioning's cleanup computes (src/provisioning/frontdoor-plan.ts, ADR-0010
 * amended 2026-11-11) against the same vectors.
 */
describe("frontdoor-plan.ts names against the shared naming vectors", () => {
  const zone = (i: Input): string => (typeof i.dnsZone === "string" ? i.dnsZone : "contoso.com");
  const FD: { key: string; run: (i: Input) => string }[] = [
    { key: "platformResourceGroup", run: (i) => fd.platformResourceGroup(i.prefix, i.env) },
    { key: "frontDoorProfile", run: (i) => fd.frontDoorProfile(i.prefix, i.env) },
    { key: "frontDoorEndpoint", run: (i) => fd.frontDoorEndpoint(i.prefix, i.env) },
    { key: "frontDoorOriginGroup", run: (i) => fd.frontDoorOriginGroup(i.slug, i.env) },
    { key: "frontDoorRoute", run: (i) => fd.frontDoorRoute(i.slug, i.env) },
    { key: "frontDoorDeployment", run: (i) => fd.frontDoorDeployment(i.slug, i.env) },
    { key: "frontDoorCustomDomain", run: (i) => fd.frontDoorCustomDomain(i.host as string) },
    { key: "frontDoorValidationRecord", run: (i) => fd.frontDoorValidationRecord(i.host as string) },
    { key: "dnsHostRecord", run: (i) => fd.dnsRelativeRecordName(i.host as string, zone(i)) },
    { key: "dnsValidationRecord", run: (i) => fd.dnsRelativeRecordName(fd.frontDoorValidationRecord(i.host as string), zone(i)) },
  ];
  for (const c of vectors.cases) {
    it(`${c.input.prefix}/${c.input.env}/${c.input.slug}: every Front Door name equals the vector`, () => {
      for (const p of FD) assert.equal(p.run(c.input), c.names[p.key], p.key);
    });
  }
  it("refuses a record at the zone apex or outside the zone, as naming.bicep does", () => {
    assert.throws(() => fd.dnsRelativeRecordName("contoso.com", "contoso.com"), /not below the DNS zone/);
    assert.throws(() => fd.dnsRelativeRecordName("app.fabrikam.com", "contoso.com"), /not below the DNS zone/);
  });
});

/**
 * The names the provisioning plan computes for every app of an environment (src/provisioning/names.ts,
 * ADR-0050) against the same vectors, and the invalid inputs naming.bicep refuses.
 */
describe("provisioning/names.ts against the shared naming vectors", () => {
  const PLAN: { key: string; fn: unknown; run: (i: Input) => string }[] = [
    { key: "appResourceGroup", fn: pn.appResourceGroup, run: (i) => pn.appResourceGroup(i.prefix, i.slug, i.env) },
    { key: "containerApp", fn: pn.containerApp, run: (i) => pn.containerApp(i.slug) },
    { key: "registryRepository", fn: pn.registryRepository, run: (i) => pn.registryRepository(i.slug) },
    { key: "provisioningDeployment", fn: pn.provisioningDeployment, run: (i) => pn.provisioningDeployment(i.slug, i.env) },
    { key: "releaseDeployment", fn: pn.releaseDeployment, run: (i) => pn.releaseDeployment(i.slug) },
    { key: "frontDoorDeployment", fn: pn.frontDoorDeployment, run: (i) => pn.frontDoorDeployment(i.slug, i.env) },
    { key: "entraDeployment", fn: pn.entraDeployment, run: (i) => pn.entraDeployment(i.slug, i.env) },
    { key: "entraResourceGroup", fn: pn.entraResourceGroup, run: (i) => pn.entraResourceGroup(i.prefix) },
    { key: "entraEnvironmentResourceGroup", fn: pn.entraEnvironmentResourceGroup, run: (i) => pn.entraEnvironmentResourceGroup(i.prefix, i.env) },
    { key: "platformResourceGroup", fn: pn.platformResourceGroup, run: (i) => pn.platformResourceGroup(i.prefix, i.env) },
    // The deployments the onboarding script reads its state from (ADR-0066).
    { key: "platformDeployment", fn: pn.platformDeployment, run: (i) => pn.platformDeployment(i.prefix, i.env) },
    { key: "portalDeployment", fn: pn.portalDeployment, run: (i) => pn.portalDeployment(i.prefix, i.env) },
    { key: "portalEntraDeployment", fn: pn.portalEntraDeployment, run: (i) => pn.portalEntraDeployment(i.env) },
    { key: "easyAuthSecret", fn: pn.easyAuthSecret, run: (i) => pn.easyAuthSecret(i.slug) },
    { key: "platformJobKvsetExt", fn: pn.platformJob, run: (i) => pn.platformJob(i.prefix, "kvset", "externalOnly") },
    { key: "caeExt", fn: pn.managedEnvironment, run: (i) => pn.managedEnvironment(i.prefix, "externalOnly", i.env) },
    // ADR-0053: a capacity cell's CAE and jobs (the vectors' cell, else 02), cell 01 keeping the names above.
    { key: "caeHybCell", fn: pn.cellManagedEnvironment, run: (i) => pn.cellManagedEnvironment(i.prefix, "externalHybrid", i.env, (i as { cell?: string }).cell ?? "02") },
    { key: "platformJobKvsetExtCell", fn: pn.cellPlatformJob, run: (i) => pn.cellPlatformJob(i.prefix, "kvset", "externalOnly", (i as { cell?: string }).cell ?? "02") },
    // ADR-0061: the vectors hold incarnation 0 (no key), 1 and 12.
    { key: "entraApplicationUniqueName", fn: pn.entraApplicationUniqueName, run: (i) => pn.entraApplicationUniqueName(i.prefix, i.slug, i.env, typeof i.incarnation === "number" ? i.incarnation : 0) },
  ];
  it("every name function of names.ts is in the table", () => {
    for (const fn of Object.values(pn).filter((v) => typeof v === "function")) assert.ok(PLAN.some((p) => p.fn === fn), `${(fn as { name: string }).name} has no vector`);
  });
  for (const c of vectors.cases) {
    it(`${c.input.prefix}/${c.input.env}/${c.input.slug}: every plan name equals the vector`, () => {
      for (const p of PLAN) assert.equal(p.run(c.input), c.names[p.key], p.key);
      assert.equal(pn.platformJob(c.input.prefix, "kvset", "externalHybrid"), c.names.platformJobKvsetHyb);
      assert.equal(pn.platformJob(c.input.prefix, "dbinit", "externalOnly"), c.names.platformJobDbinitExt);
      assert.equal(pn.managedEnvironment(c.input.prefix, "externalHybrid", c.input.env), c.names.caeHyb);
      assert.equal(pn.cellManagedEnvironment(c.input.prefix, "externalOnly", c.input.env, "01"), c.names.caeExt, "cell 01 is today's name");
      assert.equal(pn.cellPlatformJob(c.input.prefix, "kvset", "externalOnly", "01"), c.names.platformJobKvsetExtCell01);
    });
  }
  it("refuses the inputs naming.bicep refuses", () => {
    for (const v of vectors.invalid) {
      const i = { ...vectors.base, ...v.override } as Input;
      if (!("prefix" in v.override || "slug" in v.override || "env" in v.override)) continue;
      assert.throws(() => {
        pn.appResourceGroup(i.prefix, i.slug, i.env);
      }, /naming:/, v.label);
    }
    assert.throws(() => pn.platformJob("contoso", "kvset", "internal"), /unknown network mode/);
    const negative = vectors.invalid.find((v) => v.override.incarnation !== undefined);
    assert.ok(negative, "the vectors list a negative incarnation");
    assert.throws(() => pn.entraApplicationUniqueName("contoso", "hotel-inventory", "nonprod", negative.override.incarnation as number), /naming: incarnation/);
  });
  it("the uniqueName's shape (ENTRA_UNIQUE_NAME_RE) matches every vector, and only an incarnation above 0 has --", () => {
    for (const c of vectors.cases) {
      const name = c.names.entraApplicationUniqueName!;
      assert.match(name, pn.ENTRA_UNIQUE_NAME_RE);
      assert.equal(name.includes("--"), typeof c.input.incarnation === "number" && c.input.incarnation > 0, name);
    }
    for (const bad of ["contoso-demo-dev--i0", "contoso-demo-dev--i01", "contoso-demo-dev--x1", "contoso-demo--dev", "contoso-demo-dev--i"]) assert.doesNotMatch(bad, pn.ENTRA_UNIQUE_NAME_RE, bad);
  });
});

/**
 * The custom-domain name `platform validate app` compares across apps (src/validate-app.ts, ADR-0052):
 * equal to naming.bicep for every vector, and equal for a confusable pair exactly when check-naming.py
 * finds frontDoorCustomDomain among the pair's collisions.
 */
describe("validate-app.ts frontDoorCustomDomainName against the shared naming vectors", () => {
  it("equals frontDoorCustomDomain of every vector", () => {
    for (const c of vectors.cases) assert.equal(frontDoorCustomDomainName(c.input.host as string), c.names.frontDoorCustomDomain);
  });
  it("collides for exactly the confusable pairs that list it", () => {
    const host = (x: Partial<Input>): string => (x.host ?? vectors.base.host) as string;
    for (const p of vectors.confusable.pairs) {
      assert.equal(frontDoorCustomDomainName(host(p.a)) === frontDoorCustomDomainName(host(p.b)), p.collisions.includes("frontDoorCustomDomain"), p.label);
    }
  });
});
