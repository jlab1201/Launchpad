/**
 * lib/security/rate-limit.ts
 *
 * In-process IP-keyed rate limiter for passphrase endpoints.
 *
 * Lockout schedule after 5 consecutive failures:
 *   Math.min(60_000 * 2^(failures-5), 30 * 60_000)
 *   → failure 5:  1 min, 6: 2 min, 7: 4 min … cap: 30 min
 *
 * "unknown" IP bucket: all clients without a recognisable IP header share one
 * bucket. This is intentionally conservative — a misconfigured proxy that
 * strips X-Forwarded-For will trigger a quick lockout, surfacing the misconfig.
 *
 * Pruning: every 10 minutes entries with no failure in the last 24 h are
 * removed. A Symbol guard prevents duplicate intervals under Next.js HMR.
 */

interface Entry {
  failures: number;
  lockedUntilMs: number | null;
  lastActivityMs: number;
}

const store = new Map<string, Entry>();

const LOCK_THRESHOLD = 5;
const MAX_LOCK_MS = 30 * 60_000;
const PRUNE_INTERVAL_MS = 10 * 60_000;
const PRUNE_AGE_MS = 24 * 60 * 60_000;

// Guard against duplicate setInterval registrations under Next.js hot-reload.
const GUARD = Symbol.for("dashboard.rateLimit");
declare global {
  // eslint-disable-next-line no-var
  var __rateLimitPruner: NodeJS.Timeout | undefined;
}

if (!global.__rateLimitPruner) {
  global.__rateLimitPruner = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.lastActivityMs > PRUNE_AGE_MS) {
        store.delete(key);
      }
    }
  }, PRUNE_INTERVAL_MS).unref();
}

// Silence the unused symbol warning — the guard is purely a named constant.
void GUARD;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

function lockoutMs(failures: number): number {
  // failures is already >= LOCK_THRESHOLD when this is called.
  return Math.min(60_000 * 2 ** (failures - LOCK_THRESHOLD), MAX_LOCK_MS);
}

export function checkRateLimit(ipKey: string): RateLimitResult {
  const now = Date.now();
  const entry = store.get(ipKey);
  if (!entry) return { allowed: true };

  if (entry.lockedUntilMs !== null && now < entry.lockedUntilMs) {
    return { allowed: false, retryAfterMs: entry.lockedUntilMs - now };
  }

  // Lock expired — clear the lock flag but keep the failure count so the
  // next failure immediately re-locks (with the next doubled window).
  if (entry.lockedUntilMs !== null && now >= entry.lockedUntilMs) {
    entry.lockedUntilMs = null;
  }

  return { allowed: true };
}

export function recordFailure(ipKey: string): void {
  const now = Date.now();
  const entry = store.get(ipKey) ?? {
    failures: 0,
    lockedUntilMs: null,
    lastActivityMs: now,
  };

  entry.failures += 1;
  entry.lastActivityMs = now;

  if (entry.failures >= LOCK_THRESHOLD) {
    entry.lockedUntilMs = now + lockoutMs(entry.failures);
  }

  store.set(ipKey, entry);
}

export function recordSuccess(ipKey: string): void {
  store.delete(ipKey);
}
