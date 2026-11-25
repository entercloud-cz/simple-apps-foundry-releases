/**
 * `platform preview`: a look at the app's pages without the user's screen (dev-log 2026-11-24). A headless browser
 * with a fresh profile (never the user's browser, cookies or sign-ins) opens each path of the app running locally at
 * each width and writes a full-page screenshot, then lists what went wrong in the page: JavaScript errors, console
 * errors, failed requests and HTTP errors of the app's own address. The agent looks at the PNG files.
 *
 * The browser: --browser <path> or $SAF_BROWSER, else the installed Google Chrome, else Microsoft Edge (Playwright's
 * channels: nothing is downloaded). Only loopback addresses: the app on this computer, never an environment.
 * playwright-core is loaded only by this command.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../allowlist.js";
import { neutralize } from "../neutralize.js";

const out = (s: string): void => void process.stdout.write(neutralize(s));

export const PREVIEW_HELP = `platform preview [--url <local address>] [--path <path>]... [--width <px>]... [--out <dir>]
                         [--browser <path>] [--timeout <seconds>]
                                            screenshots of the app running locally, in a headless browser
                                            with a fresh profile (default --url http://localhost:5173,
                                            --path /, --width 1280 and 390): the PNG files and the page's
                                            errors; exit 0 clean, 1 errors in a page, 2 usage or no browser`;

export interface PreviewProblem {
  path: string;
  width: number;
  kind: "load" | "pageerror" | "console" | "request" | "http";
  text: string;
}

export interface PreviewResult {
  shots: { path: string; width: number; file: string }[];
  problems: PreviewProblem[];
}

/** The app's local address: http(s) on localhost, 127.0.0.1 or [::1] only. */
export function localUrl(value: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(`--url "${value.slice(0, 80)}" is not an address (http://localhost:5173).`);
  }
  if (!["http:", "https:"].includes(u.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password) {
    throw new UsageError("--url must be the app running on this computer (http://localhost:<port>): platform preview never opens an environment or another site.");
  }
  return u;
}

/** dashboard/plans?x=1 -> dashboard-plans; / -> home. */
export function shotName(path: string, width: number): string {
  const base = path.split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "home";
  return `${base}-${width}.png`;
}

/** One line of untrusted page text: no control characters, bounded. */
function line(s: string): string {
  const clean = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}

type Browser = import("playwright-core").Browser;

async function launch(executable: string | undefined): Promise<Browser> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    // An optional dependency of the CLI (the portal's image leaves it out): an install without it can't preview.
    throw new UsageError("platform preview needs playwright-core, an optional dependency of the platform CLI: install the CLI again without --omit=optional.");
  }
  if (executable) return chromium.launch({ headless: true, executablePath: executable });
  const tried: string[] = [];
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch (e) {
      tried.push(`${channel}: ${line(e instanceof Error ? e.message.split("\n")[0]! : String(e))}`);
    }
  }
  throw new UsageError(`No browser found (${tried.join("; ")}). Install Google Chrome or Microsoft Edge, or pass --browser <path to chrome, chromium or msedge> (or set SAF_BROWSER).`);
}

export async function preview(opts: { url: URL; paths: string[]; widths: number[]; out: string; browser?: string; timeoutMs: number }): Promise<PreviewResult> {
  const browser = await launch(opts.browser);
  const result: PreviewResult = { shots: [], problems: [] };
  try {
    for (const width of opts.widths) {
      // A fresh context per width: no cookies or storage from the user's own browser, nothing kept.
      const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
      try {
        for (const path of opts.paths) {
          const page = await context.newPage();
          const add = (kind: PreviewProblem["kind"], text: string) => result.problems.push({ path, width, kind, text: line(text) });
          page.on("pageerror", (e) => add("pageerror", e.message));
          page.on("console", (m) => {
            // "Failed to load resource" repeats a failed response, which the handlers below report for the app's
            // own address (and a missing favicon is no error of the page).
            if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) add("console", m.text());
          });
          page.on("requestfailed", (r) => {
            if (new URL(r.url()).origin === opts.url.origin) add("request", `${r.method()} ${new URL(r.url()).pathname}: ${r.failure()?.errorText ?? "failed"}`);
          });
          page.on("response", (r) => {
            if (r.status() >= 400 && new URL(r.url()).origin === opts.url.origin) add("http", `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
          });
          const target = new URL(path, opts.url);
          try {
            await page.goto(target.href, { waitUntil: "networkidle", timeout: opts.timeoutMs });
          } catch (e) {
            add("load", e instanceof Error ? e.message.split("\n")[0]! : String(e));
          }
          const file = join(opts.out, shotName(path, width));
          try {
            await page.screenshot({ path: file, fullPage: true, timeout: opts.timeoutMs });
            result.shots.push({ path, width, file });
          } catch (e) {
            add("load", `no screenshot: ${e instanceof Error ? e.message.split("\n")[0]! : String(e)}`);
          }
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return result;
}

export async function cmdPreview(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string", default: "http://localhost:5173" },
      path: { type: "string", multiple: true },
      width: { type: "string", multiple: true },
      out: { type: "string" },
      browser: { type: "string" },
      timeout: { type: "string", default: "30" },
    },
  });
  if (positionals.length > 0) throw new UsageError("platform preview takes no positional arguments: --url, --path, --width.");
  const url = localUrl(values.url);
  const paths = values.path ?? ["/"];
  for (const p of paths) if (!p.startsWith("/") || p.startsWith("//") || p.length > 200) throw new UsageError(`--path "${p.slice(0, 40)}" must be a path of the app, starting with one /.`);
  const widths = (values.width ?? ["1280", "390"]).map(Number);
  if (widths.some((w) => !Number.isInteger(w) || w < 320 || w > 3840)) throw new UsageError("--width is whole pixels, 320 to 3840.");
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 300) throw new UsageError("--timeout is whole seconds, 5 to 300.");
  const dir = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), "platform-preview-"));
  mkdirSync(dir, { recursive: true });
  const browser = values.browser ?? (process.env.SAF_BROWSER || undefined);
  const r = await preview({ url, paths, widths, out: dir, ...(browser ? { browser } : {}), timeoutMs: timeout * 1000 });
  for (const s of r.shots) out(`screenshot  ${s.width}px  ${s.path}  ${s.file}\n`);
  for (const p of r.problems) out(`PROBLEM     ${p.width}px  ${p.path}  ${p.kind}: ${p.text}\n`);
  out(r.problems.length === 0 ? `OK  ${r.shots.length} screenshot(s), no errors in the pages. Look at the files above.\n` : `${r.problems.length} problem(s) in the pages: fix them, then run platform preview again.\n`);
  return r.problems.length === 0 ? 0 : 1;
}
