import { explainCheck } from "./explanations.js";
import { canonicalRuleId, PIPELINE_CHECK_ENFORCE_FROM, rule } from "./rules.js";
import type { Finding } from "./types.js";

/**
 * New delivery checks warn before they block (ADR-0049 section 7, US04.16). A rule with
 * `enforceFrom: "YYYY-MM-DD"` (rules.ts) reports its errors as warnings before that UTC date, with
 * its explanation and the date it becomes an error; from that date on it is an error. A core
 * upgrade then never fails an app's next build overnight: the app's team sees the warning first.
 *
 * `today` is injectable (tests); the default is the current UTC date. Warnings and notes are left
 * as they are, as are rules without enforceFrom.
 */
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The enforcement date of a rule (an alias resolves to its rule) or of a delivery pipeline check, or undefined. */
export function enforceFromOf(ruleId: string): string | undefined {
  const id = canonicalRuleId(ruleId);
  if (id !== undefined) return rule(id).enforceFrom;
  return Object.hasOwn(PIPELINE_CHECK_ENFORCE_FROM, ruleId) ? PIPELINE_CHECK_ENFORCE_FROM[ruleId] : undefined;
}

/** One finding after the enforcement date rule. */
export function enforceFinding(f: Finding, today: string = todayUtc(), enforceFrom: (id: string) => string | undefined = enforceFromOf): Finding {
  if (!DATE_RE.test(today)) throw new Error(`today must be a date YYYY-MM-DD, not "${today}"`);
  const from = enforceFrom(f.ruleId);
  if (f.severity !== "error" || from === undefined || today >= from) return f;
  const why = explainCheck(f.ruleId)?.text.en;
  return {
    ...f,
    severity: "warning",
    message: `${f.message} (a warning until ${from}; an error from that date)`,
    hint: `${why ? `${why} ` : ""}This check is new: it warns until ${from} and blocks the build from that date. ${f.hint}`,
  };
}

export function enforceFindings(findings: Finding[], today: string = todayUtc(), enforceFrom: (id: string) => string | undefined = enforceFromOf): Finding[] {
  return findings.map((f) => enforceFinding(f, today, enforceFrom));
}
