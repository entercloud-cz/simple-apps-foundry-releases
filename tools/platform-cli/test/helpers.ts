import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { defaultOptions, runChecks } from "../src/run.js";
import { materialize } from "./materialize.js";
import type { Report } from "../src/run.js";
import type { CheckOptions, Finding } from "../src/types.js";

// dist/test -> package root -> repo root
export const PKG_ROOT = resolve(import.meta.dirname, "..", "..");
export const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
export const FIXTURES = join(PKG_ROOT, "test", "fixtures");
export const CLI = join(PKG_ROOT, "dist", "src", "cli.js");

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

export function tmp(prefix = "pc-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Copies a fixture into a fresh temp directory (outside any git repo) so tests can mutate it. */
export function copyFixture(name: string): string {
  const d = join(tmp(), name);
  materialize(join(FIXTURES, name), d);
  return d;
}

export function write(dir: string, rel: string, content: string | Buffer): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function opts(dir: string, extra: Partial<CheckOptions> = {}): CheckOptions {
  return { ...defaultOptions(dir), skipRuntime: true, gitleaks: "off", ...extra };
}

export async function check(dir: string, extra: Partial<CheckOptions> = {}): Promise<Report> {
  return runChecks(opts(dir, extra));
}

export function ids(findings: Finding[]): string[] {
  return findings.map((f) => f.ruleId);
}

export function errorIds(report: Report): string[] {
  return ids(report.findings.filter((f) => f.severity === "error"));
}

export function cli(args: string[], env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Installs an executable script called `name` in a new directory and returns that directory. */
export function fakeBin(name: string, script: string): string {
  const dir = tmp("pc-bin-");
  const file = join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return dir;
}

export function withPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.PATH;
  process.env.PATH = `${binDir}:${old ?? ""}`;
  return fn().finally(() => {
    process.env.PATH = old;
  });
}

export function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    process.env[k] = vars[k] as string;
  }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k] as string;
    }
  });
}

export function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}
