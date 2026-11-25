import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

export const FORBIDDEN_DIR_NAMES = ["node_modules", "bin", "obj"] as const;

export interface RepoFiles {
  /** Regular files, relative to the checked directory, POSIX separators. */
  files: string[];
  /** "git": tracked + untracked-but-not-ignored files. "walk": plain directory walk. */
  mode: "git" | "walk";
  /** Forbidden directories found by the walk (git mode derives them from file paths). */
  walkedForbiddenDirs: string[];
}

export function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

export function isGitWorkTree(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

export function listFiles(dir: string): RepoFiles {
  if (isGitWorkTree(dir)) {
    const out = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (out !== undefined) {
      const files = [...new Set(out.split("\0").filter(Boolean))].filter((f) => {
        try {
          return lstatSync(join(dir, f)).isFile();
        } catch {
          return false; // deleted in working tree, or a symlink/submodule
        }
      });
      files.sort();
      return { files, mode: "git", walkedForbiddenDirs: [] };
    }
  }
  const files: string[] = [];
  const forbidden: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? join(dir, rel) : dir;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        if ((FORBIDDEN_DIR_NAMES as readonly string[]).includes(e.name)) {
          forbidden.push(childRel);
          continue;
        }
        walk(childRel);
      } else if (e.isFile()) {
        files.push(childRel);
      }
    }
  };
  walk("");
  files.sort();
  return { files, mode: "walk", walkedForbiddenDirs: forbidden.sort() };
}

/** True when the first 8 KiB contain a NUL byte. */
export function looksBinary(absPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function toPosix(p: string): string {
  return p.split("\\").join("/");
}
