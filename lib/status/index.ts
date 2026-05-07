/**
 * lib/status/index.ts — status check orchestrator.
 *
 * Responsibilities:
 * - Resolve webapp + credential from the database.
 * - Route to the correct per-auth strategy.
 * - 30-second in-memory result cache keyed by webappId.
 * - Coalesce concurrent cache-miss calls into a single in-flight fetch.
 * - Bulk check runner for the polling endpoint.
 */

import { eq } from "drizzle-orm";
import type { StatusResult } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { credentials as credentialsTable, webapps as webappsTable } from "@/lib/db/schema";
import { decryptCredential, VaultLockedError, vaultStatus } from "@/lib/vault";
import * as basicAuth from "./strategies/basic-auth";
import * as bearerToken from "./strategies/bearer-token";
import * as none from "./strategies/none";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  result: StatusResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<StatusResult>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a status check for a single webapp by id.
 *
 * Returns cached result if fresh. Coalesces concurrent requests that arrive
 * while the cache is cold to a single underlying fetch.
 */
export async function runStatusCheck(webappId: string): Promise<StatusResult> {
  const now = Date.now();

  // Cache hit.
  const cached = cache.get(webappId);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  // Coalesce: reuse an in-flight promise if one is already running.
  const existing = inFlight.get(webappId);
  if (existing) {
    return existing;
  }

  // Cache miss and no in-flight — start a new check.
  const promise = performCheck(webappId).then((result) => {
    // Populate cache and remove from in-flight map regardless of outcome.
    cache.set(webappId, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    inFlight.delete(webappId);
    return result;
  });

  inFlight.set(webappId, promise);
  return promise;
}

/**
 * Run status checks for all registered webapps in parallel.
 */
export async function runStatusCheckAll(): Promise<Map<string, StatusResult>> {
  const db = getDb();
  const apps = await db.select({ id: webappsTable.id }).from(webappsTable);

  const entries = await Promise.all(
    apps.map(async (app) => {
      const result = await runStatusCheck(app.id);
      return [app.id, result] as const;
    }),
  );

  return new Map(entries);
}

/**
 * Clear the cache for a specific webapp, or flush all entries if no id given.
 */
export function invalidateStatusCache(webappId?: string): void {
  if (webappId !== undefined) {
    cache.delete(webappId);
  } else {
    cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function performCheck(webappId: string): Promise<StatusResult> {
  const lastCheckedAt = Date.now();

  const db = getDb();

  // Fetch webapp row.
  const webapp = await db.query.webapps.findFirst({
    where: eq(webappsTable.id, webappId),
  });

  if (!webapp) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      lastCheckedAt,
      error: "webapp_not_found",
    };
  }

  const { url, authType } = webapp;

  // No-auth apps skip vault entirely.
  if (authType === "none") {
    return none.check(url, { kind: "none" });
  }

  // Auth apps require an unlocked vault.
  const status = await vaultStatus();
  if (!status.unlocked) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      lastCheckedAt,
      error: "vault_locked",
    };
  }

  // Fetch the credential row for this webapp.
  const credRow = await db.query.credentials.findFirst({
    where: eq(credentialsTable.webappId, webappId),
  });

  if (!credRow) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      lastCheckedAt,
      error: "credential_missing",
    };
  }

  // Decrypt.
  let payload: Awaited<ReturnType<typeof decryptCredential>>;
  try {
    const ciphertext = Buffer.isBuffer(credRow.ciphertext)
      ? credRow.ciphertext
      : Buffer.from(credRow.ciphertext as Uint8Array);
    const nonce = Buffer.isBuffer(credRow.nonce)
      ? credRow.nonce
      : Buffer.from(credRow.nonce as Uint8Array);

    payload = await decryptCredential({ ciphertext, nonce });
  } catch (err) {
    if (err instanceof VaultLockedError) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: null,
        lastCheckedAt,
        error: "vault_locked",
      };
    }
    return {
      ok: false,
      statusCode: null,
      latencyMs: null,
      lastCheckedAt,
      error: "credential_decrypt_failed",
    };
  }

  // Dispatch to the correct strategy.
  if (authType === "basic" && payload.kind === "password") {
    return basicAuth.check(url, {
      kind: "basic",
      username: payload.username,
      password: payload.password,
    });
  }

  if (authType === "bearer" && payload.kind === "token") {
    return bearerToken.check(url, {
      kind: "bearer",
      token: payload.token,
    });
  }

  // Mismatched authType / credential kind.
  return {
    ok: false,
    statusCode: null,
    latencyMs: null,
    lastCheckedAt,
    error: "credential_kind_mismatch",
  };
}
