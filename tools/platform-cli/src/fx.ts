/**
 * Currency conversion of costs and budgets (ADR-0017 amendment 2026-11-11, ADR-0018): instance.yaml
 * `costs.fx`. In this iteration the only source is `fixed`: planning rates in instance.yaml, taken on
 * the day `asOf`, as units of `locale.currency` per 1 unit of the billing currency. `none` (the
 * default) converts nothing; `ecb` is reserved for a later release and converts nothing either.
 *
 * An environment's billing currency is `environments[].billingCurrency` (absent = locale.currency):
 * the currency Azure bills its subscription in, which Cost Management reports and budgets evaluate
 * in. Provisioning converts an app's budget (instance currency) into it; the portal converts costs
 * back (portal/shared/src/fx.ts mirrors these rules).
 */

export interface FxView {
  locale?: { currency?: string };
  costs?: { fx?: { source?: string; fixedRates?: Record<string, number>; asOf?: string } };
}

/** The schema default of locale.currency. */
export const DEFAULT_CURRENCY = "EUR";

export const instanceCurrencyOf = (inst: FxView): string => inst.locale?.currency ?? DEFAULT_CURRENCY;

/** The currency Azure bills an environment in: its billingCurrency, else the instance currency. */
export const billingCurrencyOf = (inst: FxView, env: { billingCurrency?: string }): string => env.billingCurrency ?? instanceCurrencyOf(inst);

export interface FxRate {
  /** Units of the instance currency per 1 unit of `from`. */
  rate: number;
  /** The day the rate was taken (YYYY-MM-DD). */
  asOf: string;
  source: "fixed";
}

/**
 * The rate from `from` to the instance currency, or undefined when the instance has none (source
 * none or ecb, or no fixed rate for that currency). Not called for the instance currency itself.
 */
export function fxRateOf(inst: FxView, from: string): FxRate | undefined {
  const fx = inst.costs?.fx;
  if (fx?.source !== "fixed" || !fx.asOf) return undefined;
  const rate = fx.fixedRates?.[from];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? { rate, asOf: fx.asOf, source: "fixed" } : undefined;
}

/**
 * A budget in the instance currency as the whole amount in the billing currency that Azure's budget
 * takes (the Budgets API amount is an integer, ADR-0017): rounded to the nearest unit, at least 1.
 */
export const budgetInBillingCurrency = (amount: number, rate: number): number => Math.max(1, Math.round(amount / rate));

/** YYYY-MM-DD that is a real calendar day. */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
