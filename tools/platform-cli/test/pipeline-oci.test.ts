import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, write } from "./helpers.js";
import { makeLayout, pipe, putBlob } from "./pipeline-helpers.js";

function digestOf(dir: string) {
  return pipe(["oci-digest", dir]);
}

describe("pipeline oci-digest", () => {
  it("prints the digest of a single linux/amd64 image manifest (OCI and Docker v2)", () => {
    const oci = makeLayout();
    const r = digestOf(oci.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${oci.digest}\n`);
    assert.match(r.stdout, /^sha256:[0-9a-f]{64}\n$/);

    const docker = makeLayout({ manifestMediaType: "application/vnd.docker.distribution.manifest.v2+json", platform: { os: "linux", architecture: "amd64" } });
    assert.equal(digestOf(docker.dir).stdout, `${docker.digest}\n`);
  });

  it("rejects an image index instead of a manifest (buildx with attestations)", () => {
    const r = digestOf(makeLayout({ asIndex: true }).dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is an image index .*--provenance=false/);
  });

  it("rejects more than one manifest", () => {
    const r = digestOf(makeLayout({ extraManifests: 1 }).dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exactly one manifest \(found 2\)/);
  });

  it("rejects a wrong platform in the config or in the descriptor", () => {
    const arm = digestOf(makeLayout({ architecture: "arm64" }).dir);
    assert.equal(arm.code, 1);
    assert.match(arm.stderr, /linux\/arm64; the platform runs linux\/amd64 only/);
    assert.equal(digestOf(makeLayout({ os: "windows" }).dir).code, 1);
    const desc = digestOf(makeLayout({ platform: { os: "linux", architecture: "arm64" } }).dir);
    assert.match(desc.stderr, /platform must be linux\/amd64/);
  });

  it("rejects a blob whose content does not match its digest", () => {
    const r = digestOf(makeLayout({ tamperManifest: true }).dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /hashes to sha256:[0-9a-f]{64}, not to its digest/);
  });

  it("rejects a missing or truncated layer and a missing oci-layout", () => {
    const short = digestOf(makeLayout({ dropLayer: true }).dir);
    assert.equal(short.code, 1);
    assert.match(short.stderr, /layers\[0\] blob .* bytes, the manifest says/);
    const l = makeLayout();
    rmSync(join(l.dir, "oci-layout"));
    assert.match(digestOf(l.dir).stderr, /oci-layout cannot be read/);
    assert.equal(digestOf(join(tmp(), "nope")).code, 1);
  });

  it("does not follow blobs out of the layout", () => {
    const l = makeLayout();
    const outside = tmp("pc-outside-");
    // Replace the manifest blob by a symlink to an identical file outside the layout.
    const name = l.digest.slice(7);
    const src = join(l.dir, "blobs", "sha256", name);
    write(outside, name, "x");
    rmSync(src);
    symlinkSync(join(outside, name), src);
    const r = digestOf(l.dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /resolves outside the layout directory/);
  });

  it("rejects an unexpected media type and a non-sha256 digest", () => {
    const l = makeLayout();
    const cfg = putBlob(l.dir, "{}");
    writeFileSync(join(l.dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.config.v1+json", ...cfg }] }));
    assert.match(digestOf(l.dir).stderr, /mediaType .* is not one of/);
    writeFileSync(join(l.dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:../../../etc/passwd", size: 1 }] }));
    assert.match(digestOf(l.dir).stderr, /digest must be sha256:<64 lowercase hex>/);
  });

  it("is a usage error without exactly one directory argument", () => {
    assert.equal(pipe(["oci-digest"]).code, 2);
    assert.equal(pipe(["oci-digest", "a", "b"]).code, 2);
  });
});
