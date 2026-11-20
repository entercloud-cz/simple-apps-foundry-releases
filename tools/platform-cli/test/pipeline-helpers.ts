import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { CLI, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";

export const PIPE = join(FIXTURES, "pipeline");
/** Built at runtime so no logging command sits in a repo file that a CI step might print. */
export const VSO = "##" + "vso[";
export const FMT = "##" + "[";

const AGENT_VARS = /^(SAF_|RESOURCES_REPOSITORIES_|BUILD_BUILDID$)/;

/** Runs `platform pipeline ...` with a clean environment (agent variables of a CI run removed). */
export function pipe(args: string[], env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_VARS.test(k)));
  const r = spawnSync(process.execPath, [CLI, "pipeline", ...args], { encoding: "utf8", env: { ...base, NO_COLOR: "1", ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export interface InstanceDoc {
  coreVersion: string;
  defaultRegion: string;
  naming: { prefix: string };
  environments: { name: string; kind: string; promoteFrom?: string; region?: string; vaultGeneration?: number; [k: string]: unknown }[];
  scanning?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The fictional example instance (config/examples), optionally changed, written to a temp file. */
export function instanceFile(mutate?: (doc: InstanceDoc) => void): string {
  const doc = parse(readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8")) as InstanceDoc;
  mutate?.(doc);
  const file = join(tmp("pc-inst-"), "instance.yaml");
  writeFileSync(file, stringify(doc));
  return file;
}

// ------------------------------------------------------------------------------------------
// OCI image layouts built from bytes
// ------------------------------------------------------------------------------------------

export function sha256(b: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(b).digest("hex");
}

export function putBlob(layout: string, content: Buffer | string): { digest: string; size: number } {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const digest = sha256(buf);
  mkdirSync(join(layout, "blobs", "sha256"), { recursive: true });
  writeFileSync(join(layout, "blobs", "sha256", digest.slice(7)), buf);
  return { digest, size: buf.length };
}

export interface LayoutOptions {
  os?: string;
  architecture?: string;
  manifestMediaType?: string;
  /** Wrap the image manifest in an image index (what buildx writes with attestations). */
  asIndex?: boolean;
  /** Extra descriptors in index.json. */
  extraManifests?: number;
  platform?: { os: string; architecture: string };
  /** Corrupt the manifest blob after its digest was computed. */
  tamperManifest?: boolean;
  dropLayer?: boolean;
}

export function makeLayout(opts: LayoutOptions = {}): { dir: string; digest: string } {
  const dir = join(tmp("pc-oci-"), "layout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const layer = putBlob(dir, Buffer.from("not really a tar.gz, the size and location are what count"));
  const config = putBlob(dir, JSON.stringify({ os: opts.os ?? "linux", architecture: opts.architecture ?? "amd64", rootfs: { type: "layers", diff_ids: [] }, config: {} }));
  const mt = opts.manifestMediaType ?? "application/vnd.oci.image.manifest.v1+json";
  const manifestJson = JSON.stringify({
    schemaVersion: 2,
    mediaType: mt,
    config: { mediaType: mt.includes("docker") ? "application/vnd.docker.container.image.v1+json" : "application/vnd.oci.image.config.v1+json", ...config },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", ...layer }],
  });
  const manifest = putBlob(dir, manifestJson);
  if (opts.tamperManifest) writeFileSync(join(dir, "blobs", "sha256", manifest.digest.slice(7)), manifestJson.replace('"schemaVersion":2', '"schemaVersion":3'));
  if (opts.dropLayer) writeFileSync(join(dir, "blobs", "sha256", layer.digest.slice(7)), "short");
  let top: Record<string, unknown> = { mediaType: mt, ...manifest, ...(opts.platform ? { platform: opts.platform } : {}) };
  if (opts.asIndex) {
    const idx = putBlob(dir, JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [top] }));
    top = { mediaType: "application/vnd.oci.image.index.v1+json", ...idx };
  }
  const manifests = [top, ...Array.from({ length: opts.extraManifests ?? 0 }, () => top)];
  writeFileSync(join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests }));
  return { dir, digest: manifest.digest };
}
