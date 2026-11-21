import type { Context } from "../context.js";
import { FORBIDDEN_DIR_NAMES } from "../files.js";
import { finding } from "../rules.js";
import type { CheckResult, Finding } from "../types.js";

const KEY_STORE_RE = /\.(?:pfx|p12|jks|keystore|key|ppk)$/i;

/** Env files that hold real values: `.env`, `.env.*` and `*.env`. `example.env` and `.env.example` (fake values) are allowed. */
export function isForbiddenEnvFile(base: string): boolean {
  if (base === "example.env" || base === ".env.example") return false;
  return /^\.env(\..+)?$/.test(base) || /^.+\.env$/.test(base);
}

export function checkForbidden(ctx: Context): CheckResult {
  const findings: Finding[] = [];
  const { files, mode, walkedForbiddenDirs } = ctx.repoFiles;
  const maxBytes = ctx.options.maxFileMb * 1024 * 1024;
  const reportedDirs = new Set<string>();

  const reportDir = (dirRel: string, name: string): void => {
    if (reportedDirs.has(dirRel)) return;
    reportedDirs.add(dirRel);
    findings.push(
      finding("PC031", {
        message: `Directory ${dirRel}/ must not be in the repository (${name} is build output or downloaded dependencies).`,
        file: dirRel,
        hint: `Delete ${dirRel}/ from the repository and list ${name}/ in .gitignore and .dockerignore. The build creates it again.`,
        aiPrompt: `Remove the directory ${dirRel}/ from version control (git rm -r --cached ${dirRel}), add "${name}/" to .gitignore and .dockerignore, then run "platform check".`,
      }),
    );
  };

  for (const d of walkedForbiddenDirs) reportDir(d, d.split("/").pop() ?? d);

  for (const rel of files) {
    const segs = rel.split("/");
    const base = segs[segs.length - 1] as string;

    // Report each forbidden directory once, at its topmost occurrence.
    const idx = segs.findIndex((s, i) => i < segs.length - 1 && (FORBIDDEN_DIR_NAMES as readonly string[]).includes(s));
    if (idx >= 0) {
      reportDir(segs.slice(0, idx + 1).join("/"), segs[idx] as string);
      continue;
    }

    if (isForbiddenEnvFile(base)) {
      findings.push(
        finding("PC030", {
          message: `${rel} must not be committed (only example.env and .env.example are allowed).`,
          file: rel,
          hint: "Environment files usually contain secrets. Delete the file from the repository and keep only an example.env with fake values.",
          aiPrompt: `Remove ${rel} from version control (git rm --cached ${rel}), add it to .gitignore, create/refresh example.env with placeholder values only (not .env.example: the agent settings deny reading .env.*), rotate any real secret that was in it, then run "platform check".`,
        }),
      );
      continue;
    }

    if (KEY_STORE_RE.test(base)) {
      findings.push(
        finding("PC033", {
          message: `${rel} looks like a key or certificate store and must not be committed.`,
          file: rel,
          hint: "Never commit private keys or certificates. Store them in Key Vault and ask the platform team if you need one.",
          aiPrompt: `Remove ${rel} from the repository and its history if it holds a private key, load the material from Key Vault via the secrets list in platform.yaml instead, and ask the owner to rotate the key. Then run "platform check".`,
        }),
      );
    }

    const size = ctx.fileSize(rel);
    if (size !== undefined && size > maxBytes) {
      findings.push(
        finding("PC032", {
          message: `${rel} is ${(size / 1024 / 1024).toFixed(1)} MB (limit ${ctx.options.maxFileMb} MB).`,
          file: rel,
          hint: "Large files do not belong in the repository. Download them at build time or store them in blob storage.",
          aiPrompt: `${rel} is larger than ${ctx.options.maxFileMb} MB. Remove it from the repository (use git rm and add it to .gitignore), and fetch or generate it during the Docker build or at runtime from storage instead. Then run "platform check".`,
        }),
      );
    }
  }

  return {
    group: "forbidden-files",
    findings,
    notes: [`Checked ${files.length} files (${mode === "git" ? "git-tracked and untracked, not ignored" : "directory walk"}).`],
  };
}
