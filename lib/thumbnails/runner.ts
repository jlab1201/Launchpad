/**
 * lib/thumbnails/runner.ts — Playwright screenshot runner.
 *
 * Captures a 1280×800 PNG of a registered webapp, injecting auth credentials
 * from the vault where needed. Writes atomically to THUMBNAIL_DIR.
 *
 * SECURITY NOTE:
 *   Decrypted credentials are used only within this function scope and are
 *   never stored in variables that survive the function call.
 */

import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright";
import { getDb } from "@/lib/db/client";
import { credentials as credsTable, webapps as webappsTable } from "@/lib/db/schema";
import { decryptCredential, vaultStatus } from "@/lib/vault";

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function getThumbnailDir(): string {
  return process.env.THUMBNAIL_DIR ?? "./data/thumbnails";
}

function ensureThumbnailDir(): void {
  const dir = getThumbnailDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Singleton browser — shared across captures, each capture gets its own
// BrowserContext so cookies / headers never leak between apps.
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;
let _launching = false;
const _launchQueue: Array<(b: Browser | null) => void> = [];

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;

  // Serialise concurrent launch attempts.
  if (_launching) {
    return new Promise<Browser>((resolve, reject) => {
      _launchQueue.push((b) => {
        if (b) resolve(b);
        else reject(new Error("Browser failed to launch"));
      });
    });
  }

  _launching = true;

  try {
    // Lazy import so Next.js doesn't try to bundle playwright on the client.
    const { chromium } = await import("playwright");

    _browser = await chromium.launch({
      headless: true,
      // --no-sandbox is required because the Docker image runs as the non-root `node` user, which Chromium's setuid sandbox cannot use. The user-namespace isolation provided by Docker is the trust boundary instead.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    // Clean up singleton on process exit.
    process.once("beforeExit", () => {
      _browser?.close().catch(() => undefined);
      _browser = null;
    });

    // Notify any callers that were waiting.
    const queued = _launchQueue.splice(0);
    for (const resolve of queued) resolve(_browser);

    return _browser;
  } catch (err) {
    _browser = null;
    const queued = _launchQueue.splice(0);
    for (const resolve of queued) resolve(null);
    throw err;
  } finally {
    _launching = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CaptureSuccess = { thumbnailUrl: string; capturedAt: number };
export type CaptureError = { error: string };
export type CaptureResult = CaptureSuccess | CaptureError;

/**
 * Replaces any occurrence of navigateUrl (or its decoded form) in a Playwright
 * error message with safeUrl so credentials are never exposed in error strings.
 */
export function redactNavigationError(err: unknown, navigateUrl: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const safeUrl = buildSafeUrl(navigateUrl);
  const safeUrlStr = safeUrl.toString();
  // Replace both the raw navigateUrl and its percent-decoded form.
  let redacted = message.split(navigateUrl).join(safeUrlStr);
  try {
    const decoded = decodeURIComponent(navigateUrl);
    if (decoded !== navigateUrl) {
      redacted = redacted.split(decoded).join(safeUrlStr);
    }
  } catch {
    // decodeURIComponent can throw on malformed sequences — ignore.
  }
  return redacted;
}

/**
 * Returns a copy of the URL with username and password stripped out.
 */
function buildSafeUrl(rawUrl: string): URL {
  const safe = new URL(rawUrl);
  safe.username = "";
  safe.password = "";
  return safe;
}

/**
 * Captures a thumbnail for the given webapp. Returns a success result with
 * the public thumbnail URL, or an error result (never throws).
 */
export async function captureThumbnail(webappId: string): Promise<CaptureResult> {
  try {
    return await _capture(webappId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

async function _capture(webappId: string): Promise<CaptureResult> {
  ensureThumbnailDir();

  const db = getDb();

  // Load webapp row.
  const webapp = await db.query.webapps.findFirst({
    where: eq(webappsTable.id, webappId),
  });

  if (!webapp) {
    return { error: `Webapp ${webappId} not found` };
  }

  // Load credential row if one exists.
  const credRow = await db.query.credentials.findFirst({
    where: eq(credsTable.webappId, webappId),
  });

  // -------------------------------------------------------------------------
  // Launch / reuse browser.
  // -------------------------------------------------------------------------

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    // Chromium binary missing or failed to launch.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Executable doesn't exist") ||
      msg.includes("browserType.launch") ||
      msg.includes("Failed to launch")
    ) {
      return {
        error:
          "browser_missing: Chromium is not installed. Run `pnpm playwright install chromium`.",
      };
    }
    return { error: `Browser launch failed: ${msg}` };
  }

  // -------------------------------------------------------------------------
  // Resolve credentials BEFORE opening a browser context.
  // This lets us bail out without touching Playwright when the vault is locked.
  // -------------------------------------------------------------------------

  let extraHeaders: Record<string, string> | undefined;
  // Prefer the user-set thumbnailUrl override; fall back to the main url.
  // The host of the override URL is what carries any injected basic-auth
  // credentials, so credentials apply to whichever URL we end up navigating.
  const captureUrl =
    webapp.thumbnailUrl && webapp.thumbnailUrl.length > 0 ? webapp.thumbnailUrl : webapp.url;
  let navigateUrl = captureUrl;

  if (credRow && webapp.authType !== "none") {
    const status = await vaultStatus();
    if (!status.unlocked) {
      return { error: "vault_locked: vault must be unlocked to capture authenticated app" };
    }

    const ct = Buffer.isBuffer(credRow.ciphertext)
      ? credRow.ciphertext
      : Buffer.from(credRow.ciphertext as Uint8Array);
    const nonce = Buffer.isBuffer(credRow.nonce)
      ? credRow.nonce
      : Buffer.from(credRow.nonce as Uint8Array);
    const payload = await decryptCredential({ ciphertext: ct, nonce });

    if (webapp.authType === "bearer") {
      if (payload.kind !== "token") {
        return { error: "Credential kind mismatch: expected token for bearer auth" };
      }
      extraHeaders = { Authorization: `Bearer ${payload.token}` };
    } else if (webapp.authType === "basic") {
      if (payload.kind !== "password") {
        return { error: "Credential kind mismatch: expected password for basic auth" };
      }
      // Inject credentials via URL — reliable for apps gated at the reverse-proxy
      // layer (nginx basic_auth, Caddy, Traefik). Playwright's setHTTPCredentials
      // only fires for WWW-Authenticate 401 challenges, which proxy-level gates
      // often skip for browser requests.
      const parsed = new URL(captureUrl);
      parsed.username = encodeURIComponent(payload.username);
      parsed.password = encodeURIComponent(payload.password);
      navigateUrl = parsed.toString();
    }
  }

  // -------------------------------------------------------------------------
  // Build per-capture context (isolated cookies + headers).
  // -------------------------------------------------------------------------

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  try {
    if (extraHeaders) {
      await context.setExtraHTTPHeaders(extraHeaders);
    }

    const page = await context.newPage();

    // Navigate with a 15s ceiling.
    try {
      await page.goto(navigateUrl, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
    } catch (navErr) {
      // Timeout or navigation error — still try to screenshot whatever loaded.
      // Redact navigateUrl from the error message before surfacing it.
      const navMsg = redactNavigationError(navErr, navigateUrl);
      if (navMsg.includes("net::") || navMsg.includes("ERR_")) {
        return { error: `Navigation failed: ${navMsg}` };
      }
      // Timeout — screenshot partial load.
    }

    // Atomic write: write to .tmp then rename.
    const dir = getThumbnailDir();
    const finalPath = path.resolve(dir, `${webappId}.png`);
    const tmpPath = `${finalPath}.tmp`;

    const screenshotBuffer = await page.screenshot({ type: "png" });
    fs.writeFileSync(tmpPath, screenshotBuffer);
    fs.renameSync(tmpPath, finalPath);

    const capturedAt = Date.now();
    return { thumbnailUrl: `/api/thumbnail/${webappId}`, capturedAt };
  } finally {
    await context.close();
  }
}
