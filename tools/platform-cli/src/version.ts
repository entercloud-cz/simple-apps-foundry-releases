import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `version` of tools/platform-cli/package.json (dist/src/version.js -> package root). */
export function toolVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
