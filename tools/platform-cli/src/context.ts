import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { listFiles, toPosix } from "./files.js";
import type { RepoFiles } from "./files.js";
import { parseYaml } from "./schema.js";
import type { ParsedYaml } from "./schema.js";
import type { CheckOptions } from "./types.js";

export interface ManifestRuntime {
  port?: number;
  size?: "xs" | "s" | "m" | "l";
  health?: { liveness?: string; readiness?: string };
  scale?: { minReplicas?: number; maxReplicas?: number };
  env?: ({ name: string; value?: string; secret?: string } | undefined)[];
}

export interface ManifestData {
  schemaVersion?: string;
  app?: string;
  build?: { dockerfile?: string; context?: string };
  runtime?: ManifestRuntime;
  secrets?: string[];
  deploy?: { branches?: string[] };
  environments?: Record<string, ManifestRuntime>;
}

export interface LoadedManifest {
  path: string;
  exists: boolean;
  text?: string;
  parsed?: ParsedYaml;
  /** Present when the file parsed; may still fail schema validation. */
  data?: ManifestData;
}

export const MANIFEST_FILE = "platform.yaml";

export class Context {
  readonly dir: string;
  private filesCache: RepoFiles | undefined;
  private manifestCache: LoadedManifest | undefined;

  constructor(readonly options: CheckOptions) {
    this.dir = resolve(options.dir);
  }

  get repoFiles(): RepoFiles {
    return (this.filesCache ??= listFiles(this.dir));
  }

  abs(rel: string): string {
    return join(this.dir, rel);
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  readText(rel: string): string | undefined {
    try {
      return readFileSync(this.abs(rel), "utf8");
    } catch {
      return undefined;
    }
  }

  get manifest(): LoadedManifest {
    if (this.manifestCache) return this.manifestCache;
    const path = this.abs(MANIFEST_FILE);
    const text = this.readText(MANIFEST_FILE);
    if (text === undefined) {
      return (this.manifestCache = { path, exists: false });
    }
    const parsed = parseYaml(text);
    const data =
      parsed.parseErrors.length === 0 && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
        ? (parsed.data as ManifestData)
        : undefined;
    return (this.manifestCache = { path, exists: true, text, parsed, ...(data ? { data } : {}) });
  }

  get port(): number {
    const p = this.manifest.data?.runtime?.port;
    return typeof p === "number" ? p : 8080;
  }

  /** Dockerfile path relative to the checked directory. */
  get dockerfileRel(): string {
    const d = this.manifest.data?.build?.dockerfile;
    return toPosix(typeof d === "string" && d ? d : "Dockerfile");
  }

  /** Build context relative to the checked directory. */
  get buildContextRel(): string {
    const c = this.manifest.data?.build?.context;
    return toPosix(typeof c === "string" && c ? c : ".");
  }

  /** True when the (possibly user-controlled) relative path stays inside the checked directory. */
  isInside(rel: string): boolean {
    if (isAbsolute(rel)) return false;
    const r = relative(this.dir, resolve(this.dir, rel));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes(".."));
  }

  fileSize(rel: string): number | undefined {
    try {
      return statSync(this.abs(rel)).size;
    } catch {
      return undefined;
    }
  }
}
