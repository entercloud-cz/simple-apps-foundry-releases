import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import { validateFile } from "../src/validate.js";
import type { ValidateResult } from "../src/validate.js";

const EXAMPLE_FILE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");

type Front = {
  mode?: string;
  managed?: { profiles: { environment: string; sku?: string; waf?: Record<string, unknown> }[] };
  external?: { profiles: { name: string; frontDoorId?: string; allowedEnvironments?: string[] }[] };
};

/** The example instance with its frontDoor changed by `mutate`, validated. */
function validate(mutate: (fd: Front, envs: string[]) => void): ValidateResult {
  const file = instanceFile((doc) => {
    const fd = doc["frontDoor"] as Front;
    mutate(fd, doc.environments.map((e) => e.name));
  });
  return validateFile("instance", file);
}

const msgs = (r: ValidateResult): string[] => (r.checks ?? []).map((c) => `${c.path}: ${c.message}`);

describe("platform validate instance: Front Door profiles", () => {
  it("accepts the Contoso example (one profile per environment)", () => {
    const r = validateFile("instance", EXAMPLE_FILE);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.checks, []);
    assert.equal(r.ok, true);
  });

  it("accepts an instance without a frontDoor section and one profile for only some environments", () => {
    assert.equal(validate((fd) => (fd.managed = { profiles: [{ environment: "prod" }] })).ok, true);
    const file = instanceFile((doc) => {
      delete doc["frontDoor"];
    });
    const r = validateFile("instance", file);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.checks, []);
  });

  it("rejects a second profile for the same environment, naming the first", () => {
    const r = validate((fd) => fd.managed?.profiles.push({ environment: "nonprod", sku: "Premium" }));
    assert.equal(r.ok, false);
    assert.deepEqual(msgs(r), [
      'frontDoor.managed.profiles[2].environment: environment "nonprod" already has a Front Door profile (frontDoor.managed.profiles[0]); each environment has at most one.',
    ]);
  });

  it("rejects a profile for an environment that does not exist, listing the environments", () => {
    const r = validate((fd) => fd.managed?.profiles.push({ environment: "staging" }));
    assert.equal(r.ok, false);
    assert.deepEqual(msgs(r), ['frontDoor.managed.profiles[2].environment: "staging" is not an environment of this instance (nonprod, prod).']);
  });

  it("reports every problem, and an unknown environment listed twice is reported for each entry", () => {
    const r = validate((fd) => {
      fd.managed?.profiles.push({ environment: "staging" }, { environment: "staging" }, { environment: "prod" });
    });
    assert.deepEqual(
      msgs(r).map((m) => m.split(": ")[0]),
      [
        "frontDoor.managed.profiles[2].environment",
        "frontDoor.managed.profiles[3].environment",
        "frontDoor.managed.profiles[3].environment",
        "frontDoor.managed.profiles[4].environment",
      ],
    );
    assert.match(msgs(r)[2] ?? "", /already has a Front Door profile \(frontDoor\.managed\.profiles\[2\]\)/);
    assert.match(msgs(r)[3] ?? "", /"prod" already has a Front Door profile \(frontDoor\.managed\.profiles\[1\]\)/);
  });

  it("checks the external profiles: unique names, allowedEnvironments name environments, each once", () => {
    const external = (profiles: NonNullable<Front["external"]>["profiles"]) => (fd: Front): void => {
      delete fd.managed;
      fd.mode = "external";
      fd.external = { profiles };
    };
    assert.equal(validate(external([{ name: "central", allowedEnvironments: ["prod", "nonprod"] }, { name: "edge" }])).ok, true);
    const r = validate(
      external([
        { name: "central", allowedEnvironments: ["prod", "staging", "prod"] },
        { name: "Central" },
      ]),
    );
    assert.deepEqual(msgs(r), [
      'frontDoor.external.profiles[0].allowedEnvironments[1]: "staging" is not an environment of this instance (nonprod, prod).',
      'frontDoor.external.profiles[0].allowedEnvironments[2]: environment "prod" is listed more than once in this profile.',
      'frontDoor.external.profiles[1].name: profile name "Central" is already used by frontDoor.external.profiles[0]; names are unique (compared without case).',
    ]);
  });

  it("runs only on a schema-valid file (schema problems come alone)", () => {
    const r = validate((fd) => fd.managed?.profiles.push({ environment: "nonprod" }, { environment: "Bad Name" }));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.path === "frontDoor.managed.profiles[3].environment"));
    assert.deepEqual(r.checks, []);
  });
});

describe("platform validate instance: currency conversion (costs.fx)", () => {
  type Fx = { source?: string; fixedRates?: Record<string, number>; asOf?: string };
  /** The example with costs.fx replaced and environment billing currencies set. */
  function withFx(fx: Fx | undefined, billing: Record<string, string> = {}): ValidateResult {
    const file = instanceFile((doc) => {
      const costs = doc["costs"] as { fx?: Fx };
      if (fx === undefined) delete costs.fx;
      else costs.fx = fx;
      for (const e of doc.environments) if (billing[e.name]) e["billingCurrency"] = billing[e.name];
    });
    return validateFile("instance", file);
  }
  const rates = { USD: 0.92, GBP: 1.15 };

  it("accepts fixed rates with environments billed in the instance currency or in a currency with a rate", () => {
    assert.deepEqual(msgs(withFx({ source: "fixed", fixedRates: rates, asOf: "2026-11-01" })), []);
    assert.deepEqual(msgs(withFx({ source: "fixed", fixedRates: rates, asOf: "2026-11-01" }, { prod: "USD", nonprod: "EUR" })), []);
    assert.deepEqual(msgs(withFx({ source: "fixed", fixedRates: { ...rates, EUR: 1 }, asOf: "2024-02-29" })), [], "the instance currency as 1; a leap day");
    assert.deepEqual(msgs(withFx(undefined)), [], "no fx and every environment in the instance currency");
  });

  it("rejects an environment billed in another currency without a fixed rate (none, ecb, or no rate for it)", () => {
    assert.deepEqual(msgs(withFx(undefined, { prod: "USD" })), [
      "environments[1].billingCurrency: Azure bills environment prod in USD, not in the instance currency EUR, and costs.fx.source is none: set costs.fx.source to fixed with a rate for USD (costs.fx.fixedRates, costs.fx.asOf).",
    ]);
    assert.match(msgs(withFx({ source: "ecb" }, { prod: "USD" }))[0]!, /costs\.fx\.source ecb isn't built yet/);
    assert.deepEqual(msgs(withFx({ source: "fixed", fixedRates: rates, asOf: "2026-11-01" }, { nonprod: "CHF" })), [
      "environments[0].billingCurrency: Azure bills environment nonprod in CHF, but costs.fx.fixedRates has no rate for CHF (units of EUR per 1 CHF).",
    ]);
  });

  it("rejects the instance currency at a rate other than 1, and a date that isn't one", () => {
    const r = withFx({ source: "fixed", fixedRates: { ...rates, EUR: 0.5 }, asOf: "2026-02-30" });
    assert.equal(r.ok, false);
    assert.deepEqual(msgs(r), [
      "costs.fx.fixedRates.EUR: EUR is the instance currency (locale.currency): leave it out of the rates, or set it to 1.",
      'costs.fx.asOf: "2026-02-30" is not a day of the calendar (YYYY-MM-DD).',
    ]);
  });

  it("the schema: fixed needs rates and asOf; rates are positive; codes are three capitals", () => {
    const problems = (fx: Fx, billing?: Record<string, string>) => JSON.stringify(withFx(fx, billing).problems);
    assert.match(problems({ source: "fixed", fixedRates: rates }), /asOf/);
    assert.match(problems({ source: "fixed", asOf: "2026-11-01" }), /fixedRates/);
    assert.match(problems({ source: "fixed", fixedRates: {}, asOf: "2026-11-01" }), /fixedRates/);
    assert.match(problems({ source: "fixed", fixedRates: { USD: 0 }, asOf: "2026-11-01" }), /fixedRates/);
    assert.match(problems({ source: "fixed", fixedRates: { usd: 0.9 }, asOf: "2026-11-01" }), /fixedRates/);
    assert.match(problems({ source: "fixed", fixedRates: rates, asOf: "1 Nov 2026" }), /asOf/);
    assert.match(problems({ source: "none" }, { prod: "usd" }), /billingCurrency/);
  });
});

describe("platform validate instance: costs off (costs.enabled, ADR-0068)", () => {
  /** The example with costs.enabled and budgets.mode set (undefined: the key left out). */
  function withCosts(enabled: boolean | undefined, mode: string | undefined): ValidateResult {
    const file = instanceFile((doc) => {
      const costs = doc["costs"] as { enabled?: boolean };
      const budgets = doc["budgets"] as { mode?: string };
      if (enabled === undefined) delete costs.enabled;
      else costs.enabled = enabled;
      if (mode === undefined) delete budgets.mode;
      else budgets.mode = mode;
    });
    return validateFile("instance", file);
  }

  it("accepts costs off with budgets off, and costs on (or left out) with any budget mode", () => {
    assert.deepEqual(msgs(withCosts(false, "off")), []);
    for (const mode of ["off", "optional", "required", undefined]) {
      assert.deepEqual(msgs(withCosts(true, mode)), [], `costs on, budgets.mode ${mode}`);
      assert.deepEqual(msgs(withCosts(undefined, mode)), [], `costs left out, budgets.mode ${mode}`);
    }
  });

  it("rejects costs off while budgets are on: at budgets.mode when set, else at costs.enabled", () => {
    const r = withCosts(false, "required");
    assert.equal(r.ok, false);
    assert.deepEqual(msgs(r), [
      "budgets.mode: costs.enabled is false (no Cost Management in this instance's subscriptions), but budgets.mode is required: budgets live in Cost Management, so set budgets.mode to off.",
    ]);
    assert.deepEqual(msgs(withCosts(false, undefined)), [
      "costs.enabled: costs.enabled is false (no Cost Management in this instance's subscriptions), but budgets.mode is optional (the default): budgets live in Cost Management, so set budgets.mode to off.",
    ]);
  });

  it("the schema: costs.enabled is a boolean", () => {
    const file = instanceFile((doc) => {
      (doc["costs"] as Record<string, unknown>)["enabled"] = "no";
    });
    assert.match(JSON.stringify(validateFile("instance", file).problems), /costs\.enabled/);
  });
});

describe("platform validate instance: CLI", () => {
  /** The example's text with the prod profile's environment changed, so line numbers are those of the file. */
  function exampleWithProdProfileFor(env: string): string {
    const text = readFileSync(EXAMPLE_FILE, "utf8");
    assert.match(text, /- environment: prod /);
    const file = join(tmp("pc-inst-"), "instance.yaml");
    writeFileSync(file, text.replace("- environment: prod ", `- environment: ${env} `));
    return file;
  }

  it("prints the line of the offending profile and exits 1; text and JSON agree", () => {
    const file = exampleWithProdProfileFor("nonprod");
    // The prod profile (second entry) now names nonprod: its line is the one with the prod comment.
    const second = readFileSync(file, "utf8").split("\n").findIndex((l) => l.includes("# afd-contoso-prod")) + 1;
    assert.ok(second > 0, "fixture line found");

    const text = cli(["validate", "instance", file]);
    assert.equal(text.code, 1);
    assert.match(text.stdout, /^FAILED  .* is not a valid instance configuration:$/m);
    assert.ok(
      text.stdout.includes(`line ${second}: frontDoor.managed.profiles[1].environment: environment "nonprod" already has a Front Door profile (frontDoor.managed.profiles[0]); each environment has at most one.`),
      text.stdout,
    );

    const json = cli(["validate", "instance", file, "--format", "json"]);
    assert.equal(json.code, 1);
    const r = JSON.parse(json.stdout) as ValidateResult;
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, []);
    assert.equal(r.checks?.length, 1);
    assert.equal(r.checks?.[0]?.line, second);
  });

  it("exits 0 for the example, with an empty checks list in JSON", () => {
    assert.equal(cli(["validate", "instance", EXAMPLE_FILE]).code, 0);
    const json = cli(["validate", "instance", EXAMPLE_FILE, "--format", "json"]);
    assert.equal(json.code, 0);
    assert.deepEqual((JSON.parse(json.stdout) as ValidateResult).checks, []);
  });

  it("does not change the other kinds: a manifest result has no checks", () => {
    const r = validateFile("manifest", join(FIXTURES, "good-app", "platform.yaml"));
    assert.equal(r.checks, undefined);
  });
});
