/**
 * The platform CLI's sign-in to the portal (ADR-0075), with MSAL as a public client of its own
 * registration ({prefix}-portal-{env}--cli): the authorization code flow with PKCE through a loopback
 * listener on http://localhost (the system browser opens at the sign-in page; its address is printed
 * too), or the device code flow with --device-code where Conditional Access allows it. The only scope
 * is api://{portal}/apps.read, so the cached refresh token reads and never writes.
 *
 * MSAL is loaded only here, so `platform check` and the library parts don't load it.
 */
import { spawn } from "node:child_process";
import type { ICachePlugin, PublicClientApplication, TokenCacheContext } from "@azure/msal-node";
import { CACHE_FILE, readPrivate, writePrivate } from "./session.js";
import type { PortalSession } from "./session.js";

/** The session is missing, expired or for another portal: the user runs `platform login`. */
export class NotSignedIn extends Error {}

const SUCCESS_PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Signed in</title></head><body style=\"font-family:sans-serif\"><p>You are signed in to the platform CLI. You can close this window.</p><p>Jsi přihlášen do platform CLI. Okno můžeš zavřít.</p></body></html>";
const ERROR_PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Sign-in failed</title></head><body style=\"font-family:sans-serif\"><p>The sign-in failed. Return to the terminal.</p><p>Přihlášení selhalo. Vrať se do terminálu.</p></body></html>";

function cachePlugin(dir: string): ICachePlugin {
  return {
    beforeCacheAccess: async (ctx: TokenCacheContext): Promise<void> => {
      const text = readPrivate(dir, CACHE_FILE);
      if (text !== undefined) ctx.tokenCache.deserialize(text);
    },
    afterCacheAccess: async (ctx: TokenCacheContext): Promise<void> => {
      if (ctx.cacheHasChanged) writePrivate(dir, CACHE_FILE, ctx.tokenCache.serialize());
    },
  };
}

async function client(session: Pick<PortalSession, "tenantId" | "clientId">, dir: string): Promise<PublicClientApplication> {
  const msal = await import("@azure/msal-node");
  return new msal.PublicClientApplication({
    auth: { clientId: session.clientId, authority: `https://login.microsoftonline.com/${session.tenantId}` },
    cache: { cachePlugin: cachePlugin(dir) },
    // MSAL's own log stays off: it could carry personal data, and the CLI says what failed itself.
    system: { loggerOptions: { piiLoggingEnabled: false, logLevel: msal.LogLevel.Error, loggerCallback: () => undefined } },
  });
}

/** Opens the system browser at the sign-in page; failure is fine, the address is printed. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : process.env.WSL_DISTRO_NAME
          ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`]]
          : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed address is enough.
  }
}

/** Signs in interactively (or with the device code) and returns the account for the session. */
export async function signIn(
  session: Pick<PortalSession, "tenantId" | "clientId" | "scope">,
  dir: string,
  opts: { deviceCode: boolean; say: (s: string) => void },
): Promise<{ homeAccountId: string; username?: string }> {
  const pca = await client(session, dir);
  const result = opts.deviceCode
    ? await pca.acquireTokenByDeviceCode({ scopes: [session.scope], deviceCodeCallback: (r) => opts.say(`${r.message}\n`) })
    : await pca.acquireTokenInteractive({
        scopes: [session.scope],
        successTemplate: SUCCESS_PAGE,
        errorTemplate: ERROR_PAGE,
        openBrowser: async (url: string) => {
          opts.say(`Sign in in your browser. If it doesn't open, open this address:\n${url}\n`);
          openBrowser(url);
        },
      });
  if (!result?.account) throw new Error("the sign-in returned no account");
  return { homeAccountId: result.account.homeAccountId, ...(result.account.username ? { username: result.account.username } : {}) };
}

/** An access token for apps.read from the cache (refreshed when needed), or NotSignedIn. */
export async function accessToken(session: PortalSession, dir: string): Promise<string> {
  const pca = await client(session, dir);
  const accounts = await pca.getTokenCache().getAllAccounts();
  const account = accounts.find((a) => a.homeAccountId === session.homeAccountId) ?? (session.homeAccountId === undefined ? accounts[0] : undefined);
  if (!account) throw new NotSignedIn("not signed in");
  try {
    const result = await pca.acquireTokenSilent({ account, scopes: [session.scope] });
    if (!result?.accessToken) throw new NotSignedIn("no token");
    return result.accessToken;
  } catch (e) {
    if (e instanceof NotSignedIn) throw e;
    const name = e instanceof Error ? e.name : "";
    const code = (e as { errorCode?: unknown }).errorCode;
    // An expired or revoked refresh token, a changed password or a Conditional Access requirement:
    // MSAL can't get a token without the user.
    if (name === "InteractionRequiredAuthError" || code === "invalid_grant" || code === "no_tokens_found" || code === "interaction_required") throw new NotSignedIn(String(code ?? name));
    throw new Error(`Entra ID didn't give a token: ${typeof code === "string" ? code : name || "unknown error"}`);
  }
}
