import { createHash } from "node:crypto";
import { CheckFailed } from "../pipeline/common.js";

/**
 * Git helpers of `platform ado` for app repositories (ADR-0039) and platform-config (ADR-0040):
 * branch ACL tokens and REST push changes. Pure functions, no network. The files themselves come
 * from the same renderer as `platform repo render` (src/repo/render.ts).
 */

/** oldObjectId of a ref that doesn't exist yet (REST pushes, "Initial commit (Create a new branch)"). */
export const ZERO_ID = "0".repeat(40);

/** A name part of a Git ref as the Git Repositories security namespace spells it: UTF-16LE, hex. */
export function hexUtf16le(part: string): string {
  return Buffer.from(part, "utf16le").toString("hex");
}

/**
 * The ACL token of a branch or branch folder in the Git Repositories namespace:
 * `repoV2/{projectId}/{repoId}/refs/heads/{hex}/{hex}/`, each name part hex-encoded UTF-16LE
 * (Microsoft Learn, namespace reference; e.g. `main` = `6d00610069006e00`). A folder token covers
 * every branch below it. `branch` is a short name (`main`, `portal/requests`) or `refs/heads/...`.
 * TODO(verify) ADO-25, PORTAL-11: lower-case hex and the trailing slash, as Azure DevOps stores them.
 */
export function branchToken(projectId: string, repoId: string, branch: string): string {
  const name = branch.replace(/^refs\/heads\//, "").replace(/\/+$/, "");
  const parts = name.split("/");
  if (!name || parts.some((p) => !p || p === "." || p === "..")) throw new CheckFailed([`invalid branch name "${branch.slice(0, 80)}".`]);
  return `repoV2/${projectId}/${repoId}/refs/heads/${parts.map(hexUtf16le).join("/")}/`;
}

/**
 * The ACL token of one tag in the Git Repositories namespace: `repoV2/{projectId}/{repoId}/refs/tags/{hex}`, each
 * name part hex-encoded UTF-16LE, without a trailing slash (as the sandbox wrote it, ADO-23: a Force push deny
 * there refuses deleting and moving the tag; one on `refs/tags` itself has no effect). `tag` is a short name
 * (`v1.2.0`) or `refs/tags/...`. Verify in sandbox: ONB-2 (a plan after the apply shows the deny as set, i.e.
 * Azure DevOps keeps the token as written).
 */
export function tagToken(projectId: string, repoId: string, tag: string): string {
  const name = tag.replace(/^refs\/tags\//, "");
  const parts = name.split("/");
  if (!name || parts.some((p) => !p || p === "." || p === "..")) throw new CheckFailed([`invalid tag name "${tag.slice(0, 80)}".`]);
  return `repoV2/${projectId}/${repoId}/refs/tags/${parts.map(hexUtf16le).join("/")}`;
}

/** The Git blob object ID of `content` (what the Items API returns as objectId). */
export function gitBlobId(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** A change of a REST push (base64, so binary files survive; Microsoft Learn, Pushes - Create). */
export function pushChange(c: { change: "add" | "edit" | "delete"; path: string; content: Buffer }): Record<string, unknown> {
  if (c.change === "delete") return { changeType: "delete", item: { path: `/${c.path}` } };
  return { changeType: c.change, item: { path: `/${c.path}` }, newContent: { content: c.content.toString("base64"), contentType: "base64encoded" } };
}
