// Bundles the JSON Schemas from config/schema into dist/schemas at build time.
// The CLI never reads anything outside its own package at runtime.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const source = resolve(pkgRoot, "../../config/schema");
const target = join(pkgRoot, "dist", "schemas");

if (!existsSync(source)) {
  console.error(`copy-schemas: ${source} not found. Build from a full checkout of the core repo.`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
const files = readdirSync(source).filter((f) => f.endsWith(".schema.json"));
if (files.length === 0) {
  console.error(`copy-schemas: no *.schema.json files in ${source}`);
  process.exit(1);
}
for (const f of files) cpSync(join(source, f), join(target, f));
console.log(`copy-schemas: bundled ${files.join(", ")}`);
