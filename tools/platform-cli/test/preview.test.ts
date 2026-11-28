import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { REPO_ROOT, tmp } from "./helpers.js";
import { UsageError } from "../src/allowlist.js";
import { cmdPreview, localUrl, preview, shotName } from "../src/preview/index.js";

describe("platform preview: arguments", () => {
  it("only the app on this computer: localhost, 127.0.0.1, [::1]", () => {
    assert.equal(localUrl("http://localhost:5173").origin, "http://localhost:5173");
    assert.equal(localUrl("http://127.0.0.1:8080/").origin, "http://127.0.0.1:8080");
    assert.equal(localUrl("http://[::1]:3000").host, "[::1]:3000");
    for (const bad of ["https://portal.contoso.com", "http://test-02-test.contoso.com", "http://user:pw@localhost:5173", "file:///etc/passwd", "localhost:5173"]) {
      assert.throws(() => localUrl(bad), UsageError, bad);
    }
  });

  it("names a screenshot after the path and the width", () => {
    assert.equal(shotName("/", 1280), "home-1280.png");
    assert.equal(shotName("/plans/2026?x=1#top", 390), "plans-2026-390.png");
    assert.equal(shotName("/../../etc", 390), "..-..-etc-390.png");
    assert.ok(!shotName("/a/b/../c", 390).includes("/"));
  });

  it("refuses wrong paths, widths and timeouts before it starts a browser", async () => {
    await assert.rejects(cmdPreview(["--url", "https://example.org"]), /never opens an environment/);
    await assert.rejects(cmdPreview(["--path", "plans"]), /must be a path of the app/);
    await assert.rejects(cmdPreview(["--path", "//evil.example.org/x"]), /must be a path of the app/);
    await assert.rejects(cmdPreview(["--width", "100"]), /--width/);
    await assert.rejects(cmdPreview(["--timeout", "1"]), /--timeout/);
    await assert.rejects(cmdPreview(["http://localhost:5173"]), /no positional arguments/);
  });
});

describe("platform preview: playwright-core stays optional", () => {
  it("the CLI compiles without it: no static import and no type from the module (the pipelines build with --omit=optional)", () => {
    const src = readFileSync(join(REPO_ROOT, "tools/platform-cli/src/preview/index.ts"), "utf8");
    assert.doesNotMatch(src, /from\s+["']playwright-core["']/);
    assert.doesNotMatch(src, /import\(\s*["']playwright-core["']\s*\)/);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "tools/platform-cli/package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    assert.ok(pkg.optionalDependencies?.["playwright-core"] && !pkg.dependencies?.["playwright-core"], "playwright-core is an optional dependency");
  });
});

describe("platform preview: a headless browser", () => {
  it("screenshots each path at each width and reports the page's errors (skipped without Chrome, Edge or SAF_BROWSER)", async (t) => {
    const pages: Record<string, string> = {
      "/": "<!doctype html><title>ok</title><h1>Plan</h1>",
      "/broken": "<!doctype html><title>broken</title><h1>Broken</h1><script>console.error('boom'); fetch('/api/missing'); undefinedFn();</script>",
    };
    const server = createServer((q, r) => {
      const body = pages[q.url ?? ""];
      if (body) {
        r.setHeader("content-type", "text/html");
        r.end(body);
      } else {
        r.statusCode = 404;
        r.end("not found");
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const out = tmp("pc-preview-");
    try {
      let result;
      try {
        result = await preview({ url, paths: ["/", "/broken"], widths: [1280, 390], out, timeoutMs: 20_000, ...(process.env.SAF_BROWSER ? { browser: process.env.SAF_BROWSER } : {}) });
      } catch (e) {
        if (e instanceof UsageError && /No browser found/.test(e.message)) {
          t.skip("no Chrome or Edge on this machine");
          return;
        }
        throw e;
      }
      assert.deepEqual(result.shots.map((s) => [s.path, s.width]), [["/", 1280], ["/broken", 1280], ["/", 390], ["/broken", 390]]);
      for (const s of result.shots) assert.ok(existsSync(s.file) && statSync(s.file).size > 1000, s.file);
      // The clean page has none; the broken one its JavaScript error, console error and 404, at both widths.
      assert.deepEqual(result.problems.filter((p) => p.path === "/"), []);
      const kinds = result.problems.filter((p) => p.width === 390).map((p) => p.kind).sort();
      assert.deepEqual(kinds, ["console", "http", "pageerror"]);
      assert.ok(result.problems.some((p) => p.kind === "pageerror" && /undefinedFn/.test(p.text)));
    } finally {
      server.close();
    }
  });
});
