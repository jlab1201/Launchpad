/**
 * lib/status/strategies/none.ts — plain unauthenticated status check.
 *
 * Performs a HEAD request first; falls back to GET if the server responds 405.
 * Never throws — all errors are captured into StatusResult.error.
 */

import { fetch } from "undici";
import type { StatusResult } from "@/lib/contracts";

export interface AuthOpts {
  kind: "none";
}

export async function check(url: string, _opts: AuthOpts): Promise<StatusResult> {
  return fetchWithFallback(url, {});
}

// ---------------------------------------------------------------------------
// Internal helpers (shared by other strategies)
// ---------------------------------------------------------------------------

/**
 * Perform a HEAD (with optional headers), fall back to GET on 405.
 * Exported so other strategies can reuse the HEAD→GET dance.
 */
export async function fetchWithFallback(
  url: string,
  headers: Record<string, string>,
): Promise<StatusResult> {
  const lastCheckedAt = Date.now();

  // Attempt HEAD first.
  const headResult = await attemptFetch(url, "HEAD", headers);
  if (headResult.type === "error") {
    return {
      ok: false,
      statusCode: null,
      latencyMs: headResult.latencyMs,
      lastCheckedAt,
      error: headResult.error,
    };
  }

  if (headResult.statusCode === 405) {
    // Server does not accept HEAD — retry with GET.
    const getResult = await attemptFetch(url, "GET", headers);
    if (getResult.type === "error") {
      return {
        ok: false,
        statusCode: null,
        latencyMs: getResult.latencyMs,
        lastCheckedAt,
        error: getResult.error,
      };
    }
    return {
      ok: getResult.statusCode >= 200 && getResult.statusCode < 400,
      statusCode: getResult.statusCode,
      latencyMs: getResult.latencyMs,
      lastCheckedAt,
      error: null,
    };
  }

  return {
    ok: headResult.statusCode >= 200 && headResult.statusCode < 400,
    statusCode: headResult.statusCode,
    latencyMs: headResult.latencyMs,
    lastCheckedAt,
    error: null,
  };
}

type FetchSuccess = { type: "success"; statusCode: number; latencyMs: number };
type FetchError = { type: "error"; error: string; latencyMs: number };

async function attemptFetch(
  url: string,
  method: "HEAD" | "GET",
  headers: Record<string, string>,
): Promise<FetchSuccess | FetchError> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return { type: "success", statusCode: response.status, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const error = normaliseError(err);
    return { type: "error", error, latencyMs };
  }
}

function normaliseError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.message.includes("timed out")) {
      return "request timed out after 5000ms";
    }
    return err.message;
  }
  return String(err);
}
