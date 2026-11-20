// Runs the CLI against a fixture: node scripts/demo.mjs <good-app|bad-app> [extra check args]
// Fixtures are stored under neutral names; they are materialized into a temp directory first.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [name = "bad-app", ...extra] = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), "platform-demo-"));
const dest = join(tmp, name);
try {
  const m = spawnSync(process.execPath, [join(pkg, "dist/test/materialize.js"), name, dest], { stdio: "ignore" });
  if (m.status !== 0) throw new Error("materialize failed; run `npm run build` first");
  const r = spawnSync(process.execPath, [join(pkg, "dist/src/cli.js"), "check", dest, "--skip-runtime", ...extra], { stdio: "inherit" });
  process.exitCode = r.status ?? 2;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
