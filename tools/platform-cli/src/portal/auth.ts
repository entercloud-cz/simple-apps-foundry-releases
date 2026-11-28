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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/** The browser sign-in didn't finish in time, or the user declined it. */
export class SignInAborted extends Error {}

/**
 * The authorization code with PKCE through a loopback listener on 127.0.0.1 (redirect URI http://localhost:<port>,
 * which the CLI's registration allows on any port): opens the browser at the sign-in page and waits for the redirect,
 * at most `timeoutMs`. Its own listener, not MSAL's, so a sign-in nobody finishes ends instead of keeping the process
 * alive. Returns the code and the redirect URI it was issued for.
 */
export async function loopbackCode(
  authUrl: (redirectUri: string) => Promise<string>,
  state: string,
  opts: { timeoutMs: number; open: (url: string) => void; say: (s: string) => void },
): Promise<{ code: string; redirectUri: string }> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done());
  });
  const redirectUri = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const url = await authUrl(redirectUri);
    const code = new Promise<string>((done, fail) => {
      const timer = setTimeout(() => fail(new SignInAborted(`nobody signed in within ${Math.round(opts.timeoutMs / 60000)} minutes`)), opts.timeoutMs);
      server.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", redirectUri);
        // Only the redirect of this sign-in counts (state); anything else, a favicon or a stray request, is ignored.
        if (u.pathname !== "/" || u.searchParams.get("state") !== state) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const error = u.searchParams.get("error");
        const got = u.searchParams.get("code");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(error || !got ? ERROR_PAGE : SUCCESS_PAGE);
        clearTimeout(timer);
        if (error || !got) fail(new SignInAborted(error ? `the sign-in ended with ${error.slice(0, 80)}` : "the sign-in returned no code"));
        else done(got);
      });
    });
    opts.say(`A sign-in page opened in your browser: sign in there with your company account. If it didn't open, open this address:\n${url}\n`);
    opts.open(url);
    return { code: await code, redirectUri };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Signs in in the browser (or with the device code) and returns the account for the session. */
export async function signIn(
  session: Pick<PortalSession, "tenantId" | "clientId" | "scope">,
  dir: string,
  opts: { deviceCode: boolean; say: (s: string) => void; timeoutMs?: number },
): Promise<{ homeAccountId: string; username?: string }> {
  const msal = await import("@azure/msal-node");
  const pca = await client(session, dir);
  let result;
  if (opts.deviceCode) {
    result = await pca.acquireTokenByDeviceCode({ scopes: [session.scope], deviceCodeCallback: (r) => opts.say(`${r.message}\n`) });
  } else {
    const crypto = new msal.CryptoProvider();
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    const { code, redirectUri } = await loopbackCode(
      (redirectUri) => pca.getAuthCodeUrl({ scopes: [session.scope], redirectUri, codeChallenge: challenge, codeChallengeMethod: "S256", state, prompt: "select_account" }),
      state,
      { timeoutMs: opts.timeoutMs ?? 5 * 60_000, open: openBrowser, say: opts.say },
    );
    result = await pca.acquireTokenByCode({ code, scopes: [session.scope], redirectUri, codeVerifier: verifier });
  }
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
