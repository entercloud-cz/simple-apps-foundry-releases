import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, tmp, write } from "./helpers.js";

const SCRIPT = join(REPO_ROOT, "tools", "scripts", "check-markdown-links.mjs");

function run(dir: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("tools/scripts/check-markdown-links.mjs", () => {
  it("accepts valid relative links, anchors (incl. headings with code), images and ignores code and external links", () => {
    const dir = tmp();
    write(dir, "a.md", "# A\n\nSee [b](docs/b.md#second-heading-with-code), [self](#a), [dir](docs/), ![img](docs/i.png)\n[ref]: docs/b.md\n[web](https://example.invalid/x) [mail](mailto:a@b.c)\n```\n[ignored](nope.md)\n```\nand `[inline](nope.md)`\n");
    write(dir, "docs/b.md", "# B\n\n## Second heading `with code`\n\n[up](../a.md)\n");
    write(dir, "docs/i.png", "x");
    const r = run(dir);
    assert.equal(r.code, 0, r.out);
  });

  it("reports broken files and anchors with line numbers", () => {
    const dir = tmp();
    write(dir, "a.md", "# A\n\n[x](missing.md)\n[y](b.md#nope)\n[z](#nothing)\n");
    write(dir, "b.md", "# B\n");
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /a\.md:3: broken link: missing\.md/);
    assert.match(r.out, /a\.md:4: broken anchor: b\.md#nope/);
    assert.match(r.out, /a\.md:5: broken anchor: #nothing/);
  });
});
