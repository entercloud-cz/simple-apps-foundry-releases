import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Import from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import type { Document, Node } from "yaml";

// ajv and ajv-formats are CommonJS packages; under NodeNext the class sits on `.default`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020: any = (Ajv2020Import as any).default ?? Ajv2020Import;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (addFormatsImport as any).default ?? addFormatsImport;

export type SchemaKind = "manifest" | "instance" | "app" | "upgrades";

const SCHEMA_FILES: Record<SchemaKind, string> = {
  manifest: "app-manifest.schema.json",
  instance: "instance.schema.json",
  app: "app.schema.json",
  /** infra/app/upgrades.yaml of core (ADR-0049): `platform upgrades check`, `provisioning plan-units`. */
  upgrades: "upgrades.schema.json",
};

const compiled = new Map<SchemaKind, ValidateFunction>();
const rootSchemas = new Map<SchemaKind, { $defs?: unknown; $schema?: unknown }>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajvs = new Map<SchemaKind, any>();

/** Schemas are bundled into dist/schemas at build time (scripts/copy-schemas.mjs). */
export function schemaDir(): string {
  return join(import.meta.dirname, "..", "schemas");
}

export function getValidator(kind: SchemaKind): ValidateFunction {
  const cached = compiled.get(kind);
  if (cached) return cached;
  const schemaPath = join(schemaDir(), SCHEMA_FILES[kind]);
  let schema: object;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
  } catch (e) {
    throw new Error(`Cannot load bundled schema ${schemaPath}: ${(e as Error).message}. Run "npm run build" in tools/platform-cli.`);
  }
  // strictRequired/strictTypes are off: the instance schema uses `required` inside if/then blocks
  // without repeating `type: object`. Unknown keywords and formats still fail the build.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, verbose: true });
  addFormats(ajv);
  const validate = ajv.compile(schema) as ValidateFunction;
  compiled.set(kind, validate);
  ajvs.set(kind, ajv);
  rootSchemas.set(kind, schema as { $defs?: unknown });
  return validate;
}

export interface ParsedYaml {
  data: unknown;
  doc: Document.Parsed;
  lc: LineCounter;
  parseErrors: { message: string; line: number; column: number }[];
}

/** Parses YAML (JSON is a subset) and keeps positions for readable error locations. */
export function parseYaml(text: string): ParsedYaml {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  const parseErrors = doc.errors.map((e) => {
    const pos = lc.linePos(e.pos[0]);
    return { message: e.message.split("\n")[0] ?? e.message, line: pos.line, column: pos.col };
  });
  return { data: parseErrors.length ? undefined : doc.toJS(), doc, lc, parseErrors };
}

export interface SchemaProblem {
  /** Human path such as runtime.env[0].name; "(root)" for the document itself. */
  path: string;
  message: string;
  line?: number;
  column?: number;
  /** Description from the schema for the offending property, if any. */
  help?: string;
  keyword: string;
}

function segments(instancePath: string): (string | number)[] {
  if (!instancePath) return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function humanPath(segs: (string | number)[]): string {
  if (!segs.length) return "(root)";
  return segs.reduce<string>((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), "");
}

function locate(parsed: ParsedYaml | undefined, segs: (string | number)[], keyName?: string): { line?: number; column?: number } {
  if (!parsed) return {};
  // Walk down as far as the path exists; fall back to the deepest existing parent.
  for (let n = segs.length; n >= 0; n--) {
    const sub = segs.slice(0, n);
    const node = (n === 0 ? parsed.doc.contents : parsed.doc.getIn(sub, true)) as Node | null | undefined;
    if (!node || typeof node !== "object") continue;
    if (n === segs.length && keyName && isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && p.key.value === keyName);
      const keyRange = pair && (pair.key as Node).range;
      if (keyRange) {
        const pos = parsed.lc.linePos(keyRange[0]);
        return { line: pos.line, column: pos.col };
      }
    }
    // Point at the key of the last segment when possible, otherwise at the node.
    if (n > 0 && n === segs.length && typeof segs[n - 1] === "string") {
      const parent = n === 1 ? parsed.doc.contents : (parsed.doc.getIn(segs.slice(0, n - 1), true) as Node | null);
      if (parent && isMap(parent)) {
        const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === segs[n - 1]);
        const keyRange = pair && (pair.key as Node).range;
        if (keyRange) {
          const pos = parsed.lc.linePos(keyRange[0]);
          return { line: pos.line, column: pos.col };
        }
      }
    }
    if (node.range) {
      const pos = parsed.lc.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return {};
}

const branchValidators = new Map<string, ValidateFunction>();

/**
 * Collapses ajv's oneOf/anyOf noise: re-validates each branch on its own and keeps only the
 * errors of the best-matching branch (fewest errors).
 */
function pruneOneOf(kind: SchemaKind, errors: ErrorObject[]): ErrorObject[] {
  const ajv = ajvs.get(kind);
  const root = rootSchemas.get(kind);
  if (!ajv || !root) return errors;
  const result: ErrorObject[] = [];
  for (let i = 0; i < errors.length; i++) {
    const p = errors[i] as ErrorObject;
    if (p.keyword !== "oneOf" && p.keyword !== "anyOf") {
      result.push(p);
      continue;
    }
    // ajv emits the branch errors first and the oneOf error last: drop the contiguous run before it.
    while (result.length && (result[result.length - 1] as ErrorObject).instancePath.startsWith(p.instancePath) && (result[result.length - 1] as ErrorObject).keyword !== "oneOf") {
      result.pop();
    }
    const branches = (p.schema as unknown[]) ?? [];
    let best: ErrorObject[] | undefined;
    branches.forEach((_b, n) => {
      const branch = branches[n] as object;
      let v = branchValidators.get(`${kind}:${p.schemaPath}:${n}:${JSON.stringify(branch)}`);
      if (!v) {
        // Branches reference "#/$defs/..." of the root schema, so give them a copy of the $defs.
        v = ajv.compile({ $schema: root.$schema, $defs: root.$defs, ...branch }) as ValidateFunction;
        branchValidators.set(`${kind}:${p.schemaPath}:${n}:${JSON.stringify(branch)}`, v);
      }
      if (v((p as ErrorObject & { data?: unknown }).data)) return;
      const errs = (v.errors ?? []).map((e) => ({ ...e, instancePath: p.instancePath + e.instancePath }));
      if (!best || errs.length < best.length) best = errs;
    });
    result.push(...(best ?? [p]));
  }
  return result;
}

function describe(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `missing required property "${String(p.missingProperty)}"`;
    case "additionalProperties":
      return `unknown property "${String(p.additionalProperty)}"`;
    case "enum":
      return `must be one of: ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `must be ${JSON.stringify(p.allowedValue)}`;
    case "pattern":
      return `has an invalid format (must match ${String(p.pattern)})`;
    case "type":
      return `must be ${Array.isArray(p.type) ? (p.type as string[]).join(" or ") : String(p.type)}`;
    case "not":
      return "uses a value that is not allowed here";
    case "uniqueItems":
      return `has a duplicate entry (items ${String(p.j)} and ${String(p.i)})`;
    default:
      return e.message ?? "is invalid";
  }
}

function shorten(text: string, max = 220): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  return sentence > 60 ? cut.slice(0, sentence + 1) : cut.slice(0, max - 3) + "...";
}

export function validateData(kind: SchemaKind, data: unknown, parsed?: ParsedYaml): SchemaProblem[] {
  const validate = getValidator(kind);
  if (validate(data)) return [];
  const errors = pruneOneOf(kind, [...(validate.errors ?? [])]);
  const seen = new Set<string>();
  const problems: SchemaProblem[] = [];
  for (const e of errors) {
    const p = e.params as Record<string, unknown>;
    const segs = segments(e.instancePath);
    const keyName = e.keyword === "additionalProperties" ? String(p.additionalProperty) : undefined;
    const fullSegs = keyName ? [...segs, keyName] : e.keyword === "required" ? segs : segs;
    const message = describe(e);
    const key = `${humanPath(fullSegs)}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const loc = locate(parsed, segs, keyName);
    const description =
      e.keyword === "not"
        ? (e.schema as { description?: unknown } | undefined)?.description
        : (e.parentSchema as { description?: unknown } | undefined)?.description;
    problems.push({
      path: humanPath(fullSegs),
      message,
      ...loc,
      ...(typeof description === "string" && e.keyword !== "required" && e.keyword !== "additionalProperties"
        ? { help: shorten(description) }
        : {}),
      keyword: e.keyword,
    });
  }
  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return problems;
}
