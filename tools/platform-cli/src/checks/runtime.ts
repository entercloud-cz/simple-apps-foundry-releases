import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Context } from "../context.js";
import { neutralize } from "../neutralize.js";
import { finding } from "../rules.js";
import type { CheckResult, Finding } from "../types.js";

interface Proc {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function docker(args: string[], timeoutMs: number, cwd?: string): Proc {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error.message } : {}) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Last lines of docker output (untrusted: printed by the app's build and container). */
function tail(text: string, lines = 12): string {
  return neutralize(text.trim().split("\n").slice(-lines).join("\n"));
}

async function get(url: string): Promise<{ status?: number; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: "manual" });
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const is2xx = (s?: number): boolean => s !== undefined && s >= 200 && s < 300;

export async function checkRuntime(ctx: Context): Promise<CheckResult> {
  const opts = ctx.options;
  if (opts.skipRuntime) return { group: "runtime", findings: [], skipped: { reason: "--skip-runtime was given" } };

  const probe = docker(["version", "--format", "{{.Server.Version}}"], 30_000);
  if (probe.code !== 0 || probe.error) {
    return { group: "runtime", findings: [], skipped: { reason: "docker is not available (or its daemon is not running)" } };
  }

  const findings: Finding[] = [];
  const notes: string[] = [];
  const suffix = randomBytes(4).toString("hex");
  const container = `platform-check-${suffix}`;
  const builtTag = `platform-check/${(ctx.manifest.data?.app ?? "app").replace(/[^a-z0-9-]/g, "")}:${suffix}`;
  const image = opts.image ?? builtTag;
  const port = ctx.port;
  let started = false;

  try {
    if (!opts.image) {
      const dockerfileRel = ctx.dockerfileRel;
      if (!ctx.isInside(dockerfileRel) || !ctx.isInside(ctx.buildContextRel) || !ctx.exists(dockerfileRel)) {
        findings.push(
          finding("PC061", {
            message: `Cannot build: Dockerfile "${dockerfileRel}" or build context "${ctx.buildContextRel}" is missing or outside the repository.`,
            file: dockerfileRel,
            hint: "Fix the Dockerfile path first (see the Dockerfile check above).",
            aiPrompt: `Fix the Dockerfile location (build.dockerfile / build.context in platform.yaml), then run "platform check".`,
          }),
        );
        return { group: "runtime", findings, notes };
      }
      const build = docker(
        ["build", "--file", join(ctx.dir, dockerfileRel), "--tag", builtTag, join(ctx.dir, ctx.buildContextRel)],
        15 * 60_000,
      );
      if (build.code !== 0) {
        findings.push(
          finding("PC061", {
            message: `docker build failed${build.error ? ` (${build.error})` : ""}:\n${tail(build.stderr || build.stdout, 15)}`,
            file: dockerfileRel,
            hint: "The image does not build. Read the last lines of the build output above and fix the Dockerfile or the code it builds.",
            aiPrompt: `"docker build" fails for this repo. Build output (tail):\n${tail(build.stderr || build.stdout, 15)}\nFix the cause without weakening the Dockerfile rules (pinned base image, non-root USER), then run "platform check".`,
          }),
        );
        return { group: "runtime", findings, notes };
      }
      notes.push(`Built image ${builtTag}.`);
    } else {
      notes.push(`Using existing image ${image}.`);
    }

    const envArgs: string[] = [];
    const runtimeEnv = ctx.manifest.data?.runtime?.env ?? [];
    for (const e of runtimeEnv) if (e && typeof e.value === "string") envArgs.push("-e", `${e.name}=${e.value}`);

    const run = docker(
      [
        "run", "-d", "--name", container,
        "-e", `PORT=${port}`, ...envArgs,
        "-p", `127.0.0.1::${port}`,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--memory", "1g", "--pids-limit", "512",
        image,
      ],
      120_000,
    );
    if (run.code !== 0) {
      findings.push(
        finding("PC065", {
          message: `The container could not be started: ${tail(run.stderr || run.stdout, 6)}`,
          hint: "The image builds but will not start. Check CMD/ENTRYPOINT and that the app starts with only the PORT variable set.",
          aiPrompt: `"docker run" fails: ${tail(run.stderr || run.stdout, 6)}. Fix CMD/ENTRYPOINT so the container starts with only PORT=${port} set, then run "platform check".`,
        }),
      );
      return { group: "runtime", findings, notes };
    }
    started = true;

    const portOut = docker(["port", container, `${port}/tcp`], 20_000);
    const mapped = /:(\d+)\s*$/m.exec(portOut.stdout.trim().split("\n")[0] ?? "")?.[1];
    if (portOut.code !== 0 || !mapped) {
      findings.push(
        finding("PC062", {
          message: `Cannot find the mapped host port for container port ${port}: ${tail(portOut.stderr || portOut.stdout, 4)}`,
          hint: "The container does not publish the app port. Check that the app listens on $PORT.",
          aiPrompt: `Make the app listen on the port given in the PORT environment variable (platform.yaml runtime.port = ${port}), then run "platform check".`,
        }),
      );
      return { group: "runtime", findings, notes };
    }
    const base = `http://127.0.0.1:${mapped}`;
    const health = ctx.manifest.data?.runtime?.health?.liveness ?? "/healthz";
    // A configured readiness path is part of the contract: failing it is an error. When none is
    // configured (bring-your-own containers, ADR-0015) /readyz is only probed as advice: any
    // non-2xx answer is a warning. The starter stacks always provide /readyz and configure it.
    const explicitReadiness = ctx.manifest.data?.runtime?.health?.readiness;
    const readiness = explicitReadiness ?? "/readyz";

    // Liveness.
    const deadline = Date.now() + opts.smokeTimeoutSec * 1000;
    let last: { status?: number; error?: string } = {};
    let healthy = false;
    while (Date.now() < deadline) {
      const running = docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container], 20_000).stdout.trim();
      if (running.startsWith("false")) {
        const logs = docker(["logs", "--tail", "20", container], 20_000);
        findings.push(
          finding("PC065", {
            message: `The container exited before it became healthy (exit code ${running.split(" ")[1] ?? "?"}). Last log lines:\n${tail(logs.stdout + logs.stderr, 12)}`,
            hint: "The app crashes at startup when only PORT is set. Read the log lines above.",
            aiPrompt: `The container exits at startup with only PORT=${port} set. Log tail:\n${tail(logs.stdout + logs.stderr, 12)}\nMake the app start without secrets (degrade gracefully, read config from env), keep it listening on $PORT, then run "platform check".`,
          }),
        );
        return { group: "runtime", findings, notes };
      }
      last = await get(base + health);
      if (is2xx(last.status)) {
        healthy = true;
        break;
      }
      await sleep(1000);
    }
    if (!healthy) {
      const logs = docker(["logs", "--tail", "20", container], 20_000);
      findings.push(
        finding("PC062", {
          message: `GET ${health} did not return 2xx within ${opts.smokeTimeoutSec}s (${last.status !== undefined ? `last status ${last.status}` : `no response: ${neutralize(last.error ?? "unknown")}`}). Last log lines:\n${tail(logs.stdout + logs.stderr, 8)}`,
          hint: `The app must answer ${health} with HTTP 200 on port ${port} shortly after start, without needing secrets or a database.`,
          aiPrompt: `GET ${health} on port ${port} must return 200 within ${opts.smokeTimeoutSec}s of container start with only PORT set. Add or fix the health endpoint and make sure the app listens on 0.0.0.0:$PORT, then run "platform check". Log tail:\n${tail(logs.stdout + logs.stderr, 8)}`,
        }),
      );
      return { group: "runtime", findings, notes };
    }
    notes.push(`GET ${health} returned 2xx.`);

    // Readiness.
    const rDeadline = Date.now() + Math.min(30, opts.smokeTimeoutSec) * 1000;
    let rLast: { status?: number; error?: string } = {};
    let ready = false;
    while (Date.now() < rDeadline) {
      rLast = await get(base + readiness);
      if (is2xx(rLast.status)) {
        ready = true;
        break;
      }
      if (rLast.status === 404) break; // no point in waiting for a route that does not exist
      if (explicitReadiness === undefined && rLast.status !== undefined) break; // advisory probe: one answer is enough
      await sleep(1000);
    }
    if (ready) notes.push(`GET ${readiness} returned 2xx.`);
    else if (rLast.status === 503) {
      // "Not ready" is a legitimate answer here: the smoke test runs the image with only PORT set,
      // without the database, storage or secrets an app may wait for. The environment checks
      // readiness again (the Container Apps readiness probe) before a revision gets traffic.
      findings.push(
        finding("PC063", {
          severity: "warning",
          message: `GET ${readiness} returned 503 (not ready). The smoke test runs the image with only PORT set (no database, storage or secrets), so an app that waits for them may answer 503 here. The platform checks readiness again in the environment before the new version gets traffic.`,
          hint: `Nothing to do if ${readiness} waits for a dependency the platform provides in the environment (DATABASE_*, STORAGE_BLOB_ENDPOINT). Otherwise make it return 200 once the app can serve requests.`,
          aiPrompt: `"platform check" got 503 from ${readiness} while the app ran with only PORT set. If the app is waiting for a database, storage or secrets that the platform provides in the environment, leave it as it is. Otherwise make ${readiness} return 200 once the app can serve requests, then run "platform check".`,
        }),
      );
    } else {
      const unconfigured = explicitReadiness === undefined;
      findings.push(
        finding("PC063", {
          message: `GET ${readiness} ${rLast.status !== undefined ? `returned ${rLast.status}` : `did not answer (${rLast.error ?? "unknown"})`}.`,
          ...(unconfigured ? { severity: "warning" as const } : {}),
          hint: unconfigured
            ? `Add a ${readiness} endpoint that returns 200 when the app can serve traffic, and set runtime.health.readiness in platform.yaml, so the platform can tell "started" from "ready".`
            : `The readiness path ${readiness} must return 200 when the app is ready.`,
          aiPrompt: `Add or fix a readiness endpoint ${readiness} that returns HTTP 200 once the app can serve requests (set runtime.health.readiness in platform.yaml if you use another path), then run "platform check".`,
        }),
      );
    }

    // Non-root.
    const idOut = docker(["exec", container, "id", "-u"], 30_000);
    let uid: string | undefined = idOut.code === 0 ? idOut.stdout.trim() : undefined;
    if (uid === undefined) {
      const cfg = docker(["inspect", "--format", "{{.Config.User}}", container], 20_000).stdout.trim();
      uid = cfg === "" || cfg.split(":")[0] === "root" ? "0" : cfg.split(":")[0] ?? "0";
      notes.push(`No "id" in the image; used the configured USER (${cfg || "none"}).`);
    }
    if (uid === "0") {
      findings.push(
        finding("PC064", {
          message: "The container process runs as root (uid 0).",
          hint: "Add a USER line to the Dockerfile so the app runs as an unprivileged user.",
          aiPrompt: `The running container is uid 0. Add a non-root USER to the final Dockerfile stage and make sure the app files are readable by it, then run "platform check".`,
        }),
      );
    } else {
      notes.push(`Container runs as uid ${uid} (non-root).`);
    }
    return { group: "runtime", findings, notes };
  } finally {
    if (started) docker(["rm", "-f", container], 60_000);
    if (!opts.image) docker(["rmi", "-f", builtTag], 60_000);
  }
}
