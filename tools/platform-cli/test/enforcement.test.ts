import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DATE_RE, enforceFinding, enforceFindings, enforceFromOf } from "../src/enforcement.js";
import { explainCheck } from "../src/explanations.js";
import { RULES, finding } from "../src/rules.js";

// New delivery checks warn before they block (ADR-0049 section 7, US04.16).
describe("enforceFrom: a check warns until its enforcement date", () => {
  const f = finding("PC012", { message: "The final stage runs as root.", hint: "Add USER app.", aiPrompt: "x" });
  const from = (d: string | undefined) => (id: string) => (id === "PC012" ? d : undefined);

  it("before the date an error is a warning, with the explanation and the date", () => {
    const w = enforceFinding(f, "2026-11-30", from("2026-12-01"));
    assert.equal(w.severity, "warning");
    assert.equal(w.message, "The final stage runs as root. (a warning until 2026-12-01; an error from that date)");
    assert.ok(w.hint.startsWith(explainCheck("PC012")!.text.en), w.hint);
    assert.match(w.hint, /it warns until 2026-12-01 and blocks the build from that date\. Add USER app\.$/);
    assert.equal(f.severity, "error", "the input is not changed");
  });

  it("from the date on it is an error; rules without a date and warnings stay as they are", () => {
    assert.deepEqual(enforceFinding(f, "2026-12-01", from("2026-12-01")), f);
    assert.deepEqual(enforceFinding(f, "2027-01-01", from("2026-12-01")), f);
    assert.deepEqual(enforceFinding(f, "2026-11-30", from(undefined)), f);
    const warning = { ...f, severity: "warning" as const };
    assert.deepEqual(enforceFinding(warning, "2026-11-30", from("2026-12-01")), warning);
    assert.deepEqual(enforceFindings([f, f], "2026-11-30", from("2026-12-01")).map((x) => x.severity), ["warning", "warning"]);
  });

  it("refuses a malformed date; every enforceFrom in RULES is a date", () => {
    assert.throws(() => enforceFinding(f, "30.11.2026", from("2026-12-01")), /YYYY-MM-DD/);
    for (const r of RULES) if (r.enforceFrom !== undefined) assert.match(r.enforceFrom, DATE_RE, r.id);
    assert.equal(enforceFromOf("PC012"), RULES.find((r) => r.id === "PC012")!.enforceFrom);
    assert.equal(enforceFromOf("PC999"), undefined);
  });
});
