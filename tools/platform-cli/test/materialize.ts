import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixtures are stored under neutral names so that AI agents working on the core repo do not
 * discover them as live instructions, skills or Dockerfiles (see ADR-0013, agent tooling spike):
 *   dot-xyz          -> .xyz          (folders and files)
 *   <name>.fixture   -> <name>        (AGENTS.md.fixture, CLAUDE.md.fixture, SKILL.md.fixture, Dockerfile.fixture)
 */
export function neutralToReal(name: string): string {
  if (name.endsWith(".fixture")) return name.slice(0, -".fixture".length);
  if (name.startsWith("dot-")) return "." + name.slice(4);
  return name;
}

export function materialize(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, neutralToReal(name));
    if (statSync(from).isDirectory()) materialize(from, to);
    else cpSync(from, to);
  }
}

export const FIXTURES_DIR = resolve(import.meta.dirname, "..", "..", "test", "fixtures");

// CLI: node dist/test/materialize.js <fixture-name> <destination>
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [name, dest] = process.argv.slice(2);
  if (!name || !dest) {
    console.error("usage: materialize.js <fixture-name> <destination>");
    process.exit(2);
  }
  materialize(join(FIXTURES_DIR, name), resolve(dest));
  console.log(`Materialized fixture ${name} into ${resolve(dest)}`);
}
