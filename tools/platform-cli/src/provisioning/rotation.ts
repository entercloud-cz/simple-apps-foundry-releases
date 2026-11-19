import { CheckFailed } from "../pipeline/common.js";

/**
 * `platform provisioning rotation-due` (ADR-0041): whether an app's Easy Auth secret is due for
 * rotation, from the expiry of the version the environment vault holds (Key Vault attributes.exp,
 * epoch seconds, which the kvset job sets to the password's endDateTime). The secret lives 180 days
 * (CREDENTIAL_LIFETIME_DAYS); it is due when at most ROTATE_WITHIN_DAYS remain or it has expired.
 * A version without an expiry (written by hand) is due once it is ROTATE_AFTER_DAYS old, or when its
 * creation time is unknown too, so a fresh hand-written secret doesn't rotate (restart, approval)
 * in every run. The monthly scheduled run then rotates a secret at an age of 60 to about 91 days,
 * so about three missed runs still leave a valid password. entra_plan warns when at most
 * WARN_WITHIN_DAYS remain (rotations were missed).
 */

export const ROTATE_WITHIN_DAYS = 120;
export const ROTATE_AFTER_DAYS = 60;
export const WARN_WITHIN_DAYS = 60;
/** Epoch seconds accepted for --expires, --created, --now and the vault's times: after 2000, before 2100. */
const EPOCH_MIN = 946_684_800;
const EPOCH_MAX = 4_102_444_800;

export interface RotationDue {
  due: boolean;
  /** Whole days until the expiry (negative once expired); undefined without an expiry. */
  daysLeft: number | undefined;
}

/** "none" or epoch seconds (an integer between 2000 and 2100). */
export function parseEpoch(raw: string, flag: string): number | undefined {
  if (raw === "none") return undefined;
  if (!/^[0-9]{9,10}$/.test(raw)) throw new CheckFailed([`${flag} must be epoch seconds or none.`]);
  const n = Number(raw);
  if (n < EPOCH_MIN || n > EPOCH_MAX) throw new CheckFailed([`${flag} must be epoch seconds or none.`]);
  return n;
}

export function rotationDue(expires: number | undefined, now: number, created?: number): RotationDue {
  if (expires === undefined) return { due: created === undefined || now - created >= ROTATE_AFTER_DAYS * 86_400, daysLeft: undefined };
  const left = expires - now;
  return { due: left <= ROTATE_WITHIN_DAYS * 86_400, daysLeft: Math.floor(left / 86_400) };
}

/** One line for the provisioning scripts: "due|current <days left|none>". */
export function formatRotationDue(r: RotationDue): string {
  return `${r.due ? "due" : "current"} ${r.daysLeft === undefined ? "none" : String(r.daysLeft)}\n`;
}

export function cmdRotationDue(v: { expires: string; created?: string; now?: string }): string {
  const problems: string[] = [];
  let expires: number | undefined;
  let created: number | undefined;
  let now = Math.floor(Date.now() / 1000);
  for (const [flag, raw, set] of [
    ["--expires", v.expires, (n: number | undefined) => (expires = n)],
    ["--created", v.created ?? "none", (n: number | undefined) => (created = n)],
  ] as const) {
    try {
      set(parseEpoch(raw, flag));
    } catch (e) {
      problems.push(...(e as CheckFailed).problems);
    }
  }
  if (v.now !== undefined) {
    try {
      const n = parseEpoch(v.now, "--now");
      if (n === undefined) throw new CheckFailed(["--now must be epoch seconds."]);
      now = n;
    } catch (e) {
      problems.push(...(e as CheckFailed).problems);
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  return formatRotationDue(rotationDue(expires, now, created));
}

export const ROTATION_HELP = `  rotation-due --expires <epoch seconds|none> [--created <epoch seconds|none>] [--now <epoch seconds>]
      whether an Easy Auth secret whose vault version expires then is due for rotation (ADR-0041):
      prints "due <days left>" (at most ${ROTATE_WITHIN_DAYS} days left, or expired: negative), "current <days left>",
      or, without an expiry, "due none" (version at least ${ROTATE_AFTER_DAYS} days old per --created, or created
      unknown) or "current none"; --now defaults to the current time
`;
