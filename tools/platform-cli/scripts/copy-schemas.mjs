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

// The app templates the agent files come from (ADR-0076): templates/app/manifest.json and templates/app/agent-files,
// into dist/templates/app, so an installed CLI can run `platform agent-files update` and its check (PC057). A build
// without them (the portal's image copies only the CLI's sources) gets none and says so: those commands then need a core
// checkout. The release bundle checks that its tarball has them.
const appTemplates = resolve(pkgRoot, "../../templates/app");
const templatesTarget = join(pkgRoot, "dist", "templates", "app");
if (existsSync(join(appTemplates, "manifest.json")) && existsSync(join(appTemplates, "agent-files"))) {
  mkdirSync(templatesTarget, { recursive: true });
  cpSync(join(appTemplates, "manifest.json"), join(templatesTarget, "manifest.json"));
  cpSync(join(appTemplates, "agent-files"), join(templatesTarget, "agent-files"), { recursive: true });
  console.log("copy-templates: bundled templates/app/manifest.json and templates/app/agent-files");
} else {
  console.log("copy-templates: no templates/app next to the CLI: platform agent-files update needs a core checkout");
}
