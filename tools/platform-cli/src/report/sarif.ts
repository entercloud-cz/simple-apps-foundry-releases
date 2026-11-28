import { createHash } from "node:crypto";
import { RULES } from "../rules.js";
import type { Report } from "../run.js";
import type { Finding } from "../types.js";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

type SarifLevel = "error" | "warning" | "note";

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: unknown[];
}

function level(f: Finding): SarifLevel {
  return f.severity;
}

function fingerprint(f: Finding): string {
  return createHash("sha256")
    .update([f.ruleId, f.file ?? "", f.fingerprintSeed ?? f.message.replace(/\d+/g, "#")].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

/** SARIF requires a location for most viewers; findings without a file point at the manifest/Dockerfile. */
function fallbackFile(f: Finding): string {
  return f.group === "runtime" || f.group === "dockerfile" ? "Dockerfile" : "platform.yaml";
}

export function formatSarif(report: Report): SarifLog {
  const ruleIndex = new Map(RULES.map((r, i) => [r.id, i]));
  const results = report.findings.map((f) => {
    const uri = f.file ?? fallbackFile(f);
    return {
      ruleId: f.ruleId,
      ruleIndex: ruleIndex.get(f.ruleId),
      level: level(f),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri, uriBaseId: "%SRCROOT%" },
            region: { startLine: f.line && f.line > 0 ? f.line : 1, ...(f.column && f.column > 0 ? { startColumn: f.column } : {}) },
          },
        },
      ],
      partialFingerprints: { "platformCheck/v1": fingerprint(f) },
      properties: { group: f.group, hint: f.hint, aiPrompt: f.aiPrompt },
    };
  });

  const notifications = report.results
    .filter((r) => r.skipped)
    .map((r) => ({
      level: "note" as const,
      message: { text: `${r.group} check skipped: ${r.skipped?.reason ?? ""}` },
      descriptor: { id: r.group === "runtime" ? "PC060" : "PC021" },
    }));

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "platform-check",
            fullName: report.tool.name,
            version: report.tool.version,
            semanticVersion: report.tool.version,
            rules: RULES.map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: r.summary },
              fullDescription: { text: r.summary },
              defaultConfiguration: { level: r.severity },
              properties: { tags: ["saf", r.group] },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            exitCode: report.exitCode,
            ...(notifications.length ? { toolExecutionNotifications: notifications } : {}),
          },
        ],
        results,
      },
    ],
  };
}

/** Minimal structural validation of the SARIF 2.1.0 subset this tool emits. Returns problems. */
export function validateSarif(log: unknown): string[] {
  const problems: string[] = [];
  const o = log as Partial<SarifLog> | null;
  if (!o || typeof o !== "object") return ["log is not an object"];
  if (o.version !== "2.1.0") problems.push('version must be "2.1.0"');
  if (typeof o.$schema !== "string") problems.push("$schema must be a string");
  if (!Array.isArray(o.runs) || o.runs.length === 0) return [...problems, "runs must be a non-empty array"];
  o.runs.forEach((run, ri) => {
    const r = run as {
      tool?: { driver?: { name?: unknown; rules?: { id?: unknown }[] } };
      results?: {
        ruleId?: unknown; ruleIndex?: unknown; level?: unknown; message?: { text?: unknown };
        locations?: { physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } }[];
      }[];
    };
    const driver = r.tool?.driver;
    if (!driver || typeof driver.name !== "string" || !driver.name) problems.push(`runs[${ri}].tool.driver.name is required`);
    const rules = driver?.rules ?? [];
    if (!Array.isArray(r.results)) {
      problems.push(`runs[${ri}].results must be an array`);
      return;
    }
    r.results.forEach((res, i) => {
      const p = `runs[${ri}].results[${i}]`;
      if (typeof res.ruleId !== "string") problems.push(`${p}.ruleId is required`);
      if (typeof res.ruleIndex === "number" && rules[res.ruleIndex]?.id !== res.ruleId) problems.push(`${p}.ruleIndex does not point at rule ${String(res.ruleId)}`);
      if (!["none", "note", "warning", "error"].includes(String(res.level))) problems.push(`${p}.level is invalid`);
      if (typeof res.message?.text !== "string" || !res.message.text) problems.push(`${p}.message.text is required`);
      (res.locations ?? []).forEach((l, li) => {
        const pl = l.physicalLocation;
        if (typeof pl?.artifactLocation?.uri !== "string") problems.push(`${p}.locations[${li}].physicalLocation.artifactLocation.uri is required`);
        const sl = pl?.region?.startLine;
        if (sl !== undefined && (typeof sl !== "number" || sl < 1)) problems.push(`${p}.locations[${li}].region.startLine must be >= 1`);
      });
    });
  });
  return problems;
}
