import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, DIGEST_RE, KiB, MiB, isObject, isWithin, own, parseJsonText, readCapped, realOrFail, requireDir } from "./common.js";

/**
 * `oci-digest <layout-dir>`: the OCI image layout written by `docker buildx build --output type=oci`
 * (built from untrusted app code) must hold exactly one single-platform linux/amd64 image manifest.
 * Every path is derived from a validated sha256 digest and must resolve inside the layout.
 * Specs: https://github.com/opencontainers/image-spec/blob/main/image-layout.md, manifest.md, config.md.
 * Checked against real `buildx build --platform linux/amd64 --provenance=false --sbom=false
 * --output type=oci` exports in the sandbox (2026-10-29); the registry returned the same digest
 * after `oras cp`. The tests use layouts generated from bytes.
 */
export const MANIFEST_TYPES = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const CONFIG_TYPES = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"];
const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];

/** Registries (and the OCI spec's guidance) cap manifests at 4 MiB. */
const MAX_MANIFEST = 4 * MiB;
const MAX_CONFIG = 8 * MiB;
const MAX_INDEX = 1 * MiB;

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
}

function descriptor(v: unknown, label: string, allowedTypes: string[]): Descriptor {
  if (!isObject(v)) throw new CheckFailed([`${label} is not a descriptor object.`]);
  const mediaType = own(v, "mediaType");
  const digest = own(v, "digest");
  const size = own(v, "size");
  if (typeof mediaType !== "string") throw new CheckFailed([`${label}.mediaType is missing.`]);
  if (INDEX_TYPES.includes(mediaType)) {
    throw new CheckFailed([
      `${label} is an image index (${mediaType}), not a single image manifest. Build one linux/amd64 image without attestations (--platform linux/amd64 --provenance=false --sbom=false).`,
    ]);
  }
  if (!allowedTypes.includes(mediaType)) throw new CheckFailed([`${label}.mediaType "${mediaType.slice(0, 100)}" is not one of ${allowedTypes.join(", ")}.`]);
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) throw new CheckFailed([`${label}.digest must be sha256:<64 lowercase hex>.`]);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new CheckFailed([`${label}.size must be a non-negative integer.`]);
  return { mediaType, digest, size };
}

function blobPath(layoutReal: string, digest: string, label: string): string {
  // digest is validated against DIGEST_RE, so this is blobs/sha256/<64 hex>.
  const real = realOrFail(join(layoutReal, "blobs", "sha256", digest.slice("sha256:".length)), `${label} blob ${digest}`);
  if (!isWithin(layoutReal, real)) throw new CheckFailed([`${label} blob ${digest} resolves outside the layout directory.`]);
  return real;
}

/** Reads a blob (at most `max` bytes) and checks its size and sha256 against the descriptor. */
function readBlob(layoutReal: string, d: Descriptor, max: number, label: string): Buffer {
  const path = blobPath(layoutReal, d.digest, label);
  if (d.size > max) throw new CheckFailed([`${label} is ${d.size} bytes, more than the limit of ${max} bytes.`]);
  const buf = readCapped(path, max, `${label} blob`);
  if (buf.length !== d.size) throw new CheckFailed([`${label} blob is ${buf.length} bytes, the descriptor says ${d.size}.`]);
  const actual = "sha256:" + createHash("sha256").update(buf).digest("hex");
  if (actual !== d.digest) throw new CheckFailed([`${label} blob content hashes to ${actual}, not to its digest ${d.digest}.`]);
  return buf;
}

function parseBlobJson(buf: Buffer, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new CheckFailed([`${label} is not valid UTF-8.`]);
  }
  const v = parseJsonText(text, label);
  if (!isObject(v)) throw new CheckFailed([`${label} must be a JSON object.`]);
  return v;
}

export function ociDigest(layoutDir: string): string {
  const layoutReal = requireDir(layoutDir, "OCI layout directory");

  const marker = parseBlobJson(readCapped(join(layoutReal, "oci-layout"), 4 * KiB, "oci-layout", { noFollow: true }), "oci-layout");
  if (own(marker, "imageLayoutVersion") !== "1.0.0") throw new CheckFailed(['oci-layout must contain {"imageLayoutVersion": "1.0.0"}.']);

  const index = parseBlobJson(readCapped(join(layoutReal, "index.json"), MAX_INDEX, "index.json", { noFollow: true }), "index.json");
  if (own(index, "schemaVersion") !== 2) throw new CheckFailed(["index.json schemaVersion must be 2."]);
  const indexType = own(index, "mediaType");
  if (indexType !== undefined && indexType !== "application/vnd.oci.image.index.v1+json") {
    throw new CheckFailed(["index.json mediaType must be application/vnd.oci.image.index.v1+json."]);
  }
  const manifests = own(index, "manifests");
  if (!Array.isArray(manifests) || manifests.length !== 1) {
    throw new CheckFailed([`index.json must list exactly one manifest (found ${Array.isArray(manifests) ? manifests.length : "none"}).`]);
  }
  const top = manifests[0] as unknown;
  const md = descriptor(top, "index.json manifests[0]", MANIFEST_TYPES);
  const platform = isObject(top) ? own(top, "platform") : undefined;
  if (platform !== undefined) {
    if (!isObject(platform) || own(platform, "os") !== "linux" || own(platform, "architecture") !== "amd64") {
      throw new CheckFailed(["index.json manifests[0].platform must be linux/amd64."]);
    }
  }

  const manifest = parseBlobJson(readBlob(layoutReal, md, MAX_MANIFEST, "image manifest"), "image manifest");
  if (own(manifest, "schemaVersion") !== 2) throw new CheckFailed(["image manifest schemaVersion must be 2."]);
  const mt = own(manifest, "mediaType");
  if (mt !== undefined && mt !== md.mediaType) throw new CheckFailed([`image manifest mediaType "${String(mt).slice(0, 100)}" differs from its descriptor (${md.mediaType}).`]);
  if (own(manifest, "manifests") !== undefined) throw new CheckFailed(["image manifest contains a manifests list: it is an index, not an image manifest."]);

  const cd = descriptor(own(manifest, "config"), "image manifest config", CONFIG_TYPES);
  const config = parseBlobJson(readBlob(layoutReal, cd, MAX_CONFIG, "image config"), "image config");
  const os = own(config, "os");
  const arch = own(config, "architecture");
  if (os !== "linux" || arch !== "amd64") {
    throw new CheckFailed([`image config says ${String(os).slice(0, 40)}/${String(arch).slice(0, 40)}; the platform runs linux/amd64 only.`]);
  }

  const layers = own(manifest, "layers");
  if (!Array.isArray(layers) || layers.length === 0) throw new CheckFailed(["image manifest has no layers."]);
  const problems: string[] = [];
  layers.forEach((l: unknown, i: number) => {
    // Layer blobs can be large: existence, location and size are checked here; the registry
    // verifies their digests on push.
    if (!isObject(l)) {
      problems.push(`image manifest layers[${i}] is not a descriptor object.`);
      return;
    }
    const digest = own(l, "digest");
    const size = own(l, "size");
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      problems.push(`image manifest layers[${i}].digest must be sha256:<64 lowercase hex>.`);
      return;
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      problems.push(`image manifest layers[${i}].size must be a non-negative integer.`);
      return;
    }
    try {
      const p = blobPath(layoutReal, digest, `layers[${i}]`);
      const st = statSync(p);
      if (!st.isFile()) problems.push(`layers[${i}] blob ${digest} is not a file.`);
      else if (st.size !== size) problems.push(`layers[${i}] blob ${digest} is ${st.size} bytes, the manifest says ${size}.`);
    } catch (e) {
      if (e instanceof CheckFailed) problems.push(...e.problems);
      else throw e;
    }
  });
  if (problems.length) throw new CheckFailed(problems);
  return md.digest;
}
