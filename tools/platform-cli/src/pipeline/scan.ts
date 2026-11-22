import { CheckFailed, KiB, MiB, isObject, loadInstance, own, readJson } from "./common.js";

// ------------------------------------------------------------------------------------------
// trivy-db-age
// ------------------------------------------------------------------------------------------

/** RFC 3339 timestamp as Trivy writes it in db/metadata.json (Go time.Time, up to nanoseconds). */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** A DB "from the future" beyond this skew is treated as bad metadata. */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v !== "string" || !RFC3339_RE.test(v)) return undefined;
  // Date.parse accepts at most millisecond precision reliably: trim the fraction to 3 digits.
  const ms = Date.parse(v.replace(/\.(\d{1,9})/, (_m, f: string) => "." + f.padEnd(3, "0").slice(0, 3)));
  return Number.isFinite(ms) ? ms : undefined;
}

/** Reads UpdatedAt from Trivy's db/metadata.json and fails when it is older than maxAgeHours. */
export function trivyDbAge(args: { metadata: string; maxAgeHours: number }, now = Date.now()): string {
  const meta = readJson(args.metadata, 64 * KiB, "Trivy DB metadata");
  if (!isObject(meta)) throw new CheckFailed(["Trivy DB metadata must be a JSON object."]);
  const updatedAt = own(meta, "UpdatedAt");
  const ms = parseTimestamp(updatedAt);
  if (ms === undefined) throw new CheckFailed(["Trivy DB metadata has no valid UpdatedAt (RFC 3339 timestamp)."]);
  const ageH = (now - ms) / 3_600_000;
  if (ms - now > MAX_FUTURE_SKEW_MS) throw new CheckFailed([`Trivy DB UpdatedAt ${String(updatedAt)} lies in the future.`]);
  if (ageH > args.maxAgeHours) {
    throw new CheckFailed([`Trivy DB is ${ageH.toFixed(1)} hours old (UpdatedAt ${String(updatedAt)}), more than the allowed ${args.maxAgeHours} hours.`]);
  }
  return updatedAt as string;
}

// ------------------------------------------------------------------------------------------
// scan-gate
// ------------------------------------------------------------------------------------------

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface BlockingFinding {
  id: string;
  pkg: string;
  installed: string;
  fixed: string | null;
  severity: Severity;
}

export interface Verdict {
  provider: "trivy" | "defender";
  gate: { blockOn: "none" | "critical" | "high"; onlyWithAvailableFix: boolean };
  counts: Record<Severity, number>;
  blocking: BlockingFinding[];
  pass: boolean | null;
  reason?: string;
}

/** Trivy JSON for a large image can reach tens of MiB. */
const MAX_TRIVY_JSON = 128 * MiB;
/** Strings copied from Trivy output (image content) are capped. */
const MAX_FIELD = 200;

function field(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length > MAX_FIELD ? v.slice(0, MAX_FIELD - 3) + "..." : v;
}

interface Normalised {
  id: string;
  pkg: string;
  installed: string;
  fixed: string | null;
  severity: Severity;
  status: string | null;
}

/** Normalised, de-duplicated findings from Trivy JSON (SchemaVersion 2): Results[].Vulnerabilities[]. */
export function normaliseTrivy(report: unknown): Normalised[] {
  if (!isObject(report)) throw new CheckFailed(["Trivy report must be a JSON object."]);
  if (own(report, "SchemaVersion") !== 2) throw new CheckFailed(["Trivy report SchemaVersion must be 2 (trivy --format json)."]);
  const results = own(report, "Results");
  if (results !== undefined && results !== null && !Array.isArray(results)) throw new CheckFailed(["Trivy report Results must be a list."]);
  const out = new Map<string, Normalised>();
  const problems: string[] = [];
  (Array.isArray(results) ? results : []).forEach((r: unknown, ri: number) => {
    if (!isObject(r)) {
      problems.push(`Trivy report Results[${ri}] is not an object.`);
      return;
    }
    const vulns = own(r, "Vulnerabilities");
    if (vulns === undefined || vulns === null) return;
    if (!Array.isArray(vulns)) {
      problems.push(`Trivy report Results[${ri}].Vulnerabilities must be a list.`);
      return;
    }
    vulns.forEach((v: unknown, vi: number) => {
      const at = `Trivy report Results[${ri}].Vulnerabilities[${vi}]`;
      if (!isObject(v)) {
        problems.push(`${at} is not an object.`);
        return;
      }
      const id = field(own(v, "VulnerabilityID"));
      const pkg = field(own(v, "PkgName"));
      const installed = field(own(v, "InstalledVersion")) ?? "";
      if (!id || !pkg) {
        problems.push(`${at} has no VulnerabilityID or PkgName.`);
        return;
      }
      const sevRaw = own(v, "Severity");
      const severity: Severity = SEVERITIES.includes(sevRaw as Severity) ? (sevRaw as Severity) : "UNKNOWN";
      const fixedRaw = field(own(v, "FixedVersion"));
      const fixed = fixedRaw && fixedRaw.trim() ? fixedRaw : null;
      const status = field(own(v, "Status")) ?? null;
      const key = `${id}\u0000${pkg}\u0000${installed}`;
      const prev = out.get(key);
      // Same finding reported for several targets: keep the most severe, with a fix if any has one.
      if (!prev || SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(prev.severity)) out.set(key, { id, pkg, installed, fixed: fixed ?? prev?.fixed ?? null, severity, status });
      else if (!prev.fixed && fixed) out.set(key, { ...prev, fixed });
    });
  });
  if (problems.length) throw new CheckFailed(problems.slice(0, 20));
  return [...out.values()];
}

export function hasFix(f: { fixed: string | null; status: string | null }): boolean {
  return f.fixed !== null || f.status === "fixed";
}

export function scanGate(args: { trivy: string; instance: string }): Verdict {
  const instance = loadInstance(args.instance);
  const s = instance.scanning ?? {};
  const provider = s.provider ?? "trivy";
  const gate = { blockOn: s.blockProdPromotionOn ?? "critical", onlyWithAvailableFix: s.onlyWithAvailableFix ?? true };
  const findings = normaliseTrivy(readJson(args.trivy, MAX_TRIVY_JSON, "Trivy report"));

  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const f of findings) counts[f.severity]++;
  const blockedSeverities: Severity[] = gate.blockOn === "critical" ? ["CRITICAL"] : gate.blockOn === "high" ? ["CRITICAL", "HIGH"] : [];
  const blocking = findings
    .filter((f) => blockedSeverities.includes(f.severity) && (!gate.onlyWithAvailableFix || hasFix(f)))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id.localeCompare(b.id) || a.pkg.localeCompare(b.pkg))
    .map(({ id, pkg, installed, fixed, severity }) => ({ id, pkg, installed, fixed, severity }));

  if (provider === "defender") {
    return {
      provider,
      gate,
      counts,
      blocking,
      pass: null,
      reason: "scanning.provider is defender: the prod gate uses Microsoft Defender for Cloud findings for this digest (later increment); the Trivy results here are informational.",
    };
  }
  return { provider, gate, counts, blocking, pass: blocking.length === 0 };
}

/** `scan-gate --enforce`: problems that make the step fail (empty = the gate passes). */
export function enforcementProblems(v: Verdict): string[] {
  if (v.pass === null) return [`scanning.provider is ${v.provider}: the Defender gate is not supported by this core release.`];
  if (v.pass) return [];
  return v.blocking.map(
    (b) => `blocked: ${b.severity} ${b.id} in ${b.pkg} ${b.installed} (${b.fixed ? `fixed in ${b.fixed}` : "no fix available"}).`,
  );
}

export function formatVerdict(v: Verdict): string {
  const c = v.counts;
  const lines = [
    `${v.pass === null ? "INFO" : v.pass ? "PASS" : "WOULD BLOCK"}  ${v.provider}: block prod on ${v.gate.blockOn}${v.gate.onlyWithAvailableFix ? " (only with a fix available)" : ""}; ` +
      `CRITICAL ${c.CRITICAL}, HIGH ${c.HIGH}, MEDIUM ${c.MEDIUM}, LOW ${c.LOW}, UNKNOWN ${c.UNKNOWN}; ${v.blocking.length} blocking`,
  ];
  for (const b of v.blocking.slice(0, 50)) lines.push(`  ${b.severity.padEnd(8)} ${b.id}  ${b.pkg} ${b.installed} -> ${b.fixed ?? "(no fix)"}`);
  if (v.blocking.length > 50) lines.push(`  ... ${v.blocking.length - 50} more in the verdict file`);
  if (v.reason) lines.push(`  ${v.reason}`);
  return lines.join("\n") + "\n";
}
