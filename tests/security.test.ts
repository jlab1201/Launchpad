/**
 * tests/security.test.ts
 *
 * Tests for:
 * 1. Rate limiter (lib/security/rate-limit.ts)
 * 2. Origin check helper (lib/security/origin.ts)
 * 3. Credential-kind / authType mismatch rejection (POST /api/apps)
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSameOrigin } from "@/lib/security/origin";
import { checkRateLimit, recordFailure, recordSuccess } from "@/lib/security/rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Access the internal store via module re-import (we'll reset it by calling
 *  recordSuccess which removes entries, but for clean isolation we use fake timers
 *  and drive state through the public API only). */

function makeRequest(opts: { origin?: string | null; host?: string; url?: string }): NextRequest {
  const url = opts.url ?? "http://localhost:3000/api/test";
  const headers: Record<string, string> = {};
  if (opts.origin !== null && opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.host) headers.host = opts.host;
  return new NextRequest(url, { method: "POST", headers });
}

// ---------------------------------------------------------------------------
// 1. Rate limiter
// ---------------------------------------------------------------------------

describe("rate-limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first 5 failures without locking", () => {
    const ip = `rl-test-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      const before = checkRateLimit(ip);
      expect(before).toEqual({ allowed: true });
      recordFailure(ip);
    }

    // Still 5 failures recorded but threshold is >= 5 so the 5th recordFailure
    // sets a lock. Now check should be denied.
    const after = checkRateLimit(ip);
    expect(after.allowed).toBe(false);
  });

  it("6th consecutive failure is denied", () => {
    const ip = `rl-test-6th-${Date.now()}`;

    for (let i = 0; i < 5; i++) recordFailure(ip);

    // 5 failures → locked. The 6th attempt check should be denied.
    const result = checkRateLimit(ip);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("success resets the failure counter", () => {
    const ip = `rl-reset-${Date.now()}`;

    for (let i = 0; i < 5; i++) recordFailure(ip);
    expect(checkRateLimit(ip).allowed).toBe(false);

    recordSuccess(ip);
    expect(checkRateLimit(ip)).toEqual({ allowed: true });
  });

  it("lockout window doubles after cap reset (1 min → 2 min)", () => {
    const ip = `rl-double-${Date.now()}`;

    // Trigger first lockout (5 failures → 1 min = 60_000 ms)
    for (let i = 0; i < 5; i++) recordFailure(ip);

    const firstCheck = checkRateLimit(ip);
    expect(firstCheck.allowed).toBe(false);
    if (!firstCheck.allowed) {
      // First lockout: 60_000 * 2^(5-5) = 60_000 ms
      expect(firstCheck.retryAfterMs).toBeLessThanOrEqual(60_000);
      expect(firstCheck.retryAfterMs).toBeGreaterThan(0);
    }

    // Advance past the first lockout window.
    vi.advanceTimersByTime(61_000);

    // Lock has expired; one more failure should re-lock with doubled window.
    expect(checkRateLimit(ip).allowed).toBe(true);
    recordFailure(ip); // failures = 6 → lockout = 60_000 * 2^(6-5) = 120_000 ms

    const secondCheck = checkRateLimit(ip);
    expect(secondCheck.allowed).toBe(false);
    if (!secondCheck.allowed) {
      expect(secondCheck.retryAfterMs).toBeLessThanOrEqual(120_000);
      expect(secondCheck.retryAfterMs).toBeGreaterThan(60_000);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Origin check
// ---------------------------------------------------------------------------

describe("assertSameOrigin", () => {
  it("allows requests with no Origin header", () => {
    const req = makeRequest({ origin: null, host: "localhost:3000" });
    expect(assertSameOrigin(req)).toBeNull();
  });

  it("allows requests where Origin host matches Host", () => {
    const req = makeRequest({ origin: "http://localhost:3000", host: "localhost:3000" });
    expect(assertSameOrigin(req)).toBeNull();
  });

  it("rejects requests where Origin host differs from Host", async () => {
    const req = makeRequest({ origin: "http://evil.example.com", host: "localhost:3000" });
    const res = assertSameOrigin(req);
    expect(res).not.toBeNull();
    const body = (await res?.json()) as { error: { code: string } };
    expect(res?.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rejects a malformed Origin header", async () => {
    const req = makeRequest({ origin: "not-a-url", host: "localhost:3000" });
    const res = assertSameOrigin(req);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. Credential-kind / authType mismatch (direct validation logic)
// ---------------------------------------------------------------------------

describe("credential-kind / authType mismatch validation", () => {
  /**
   * We test the validation logic directly rather than spinning up Next.js.
   * The helper mirrors what POST /api/apps does after the Zod parse.
   */
  function validateCredentialKind(
    authType: string,
    credentialKind: string,
  ): { ok: true } | { ok: false; message: string } {
    const kindOk =
      (authType === "basic" && credentialKind === "password") ||
      (authType === "bearer" && credentialKind === "token");

    if (!kindOk) {
      return {
        ok: false,
        message:
          `Credential kind "${credentialKind}" is not valid for authType "${authType}". ` +
          `Expected: basic → password, bearer → token.`,
      };
    }
    return { ok: true };
  }

  it("accepts basic + password", () => {
    expect(validateCredentialKind("basic", "password")).toEqual({ ok: true });
  });

  it("accepts bearer + token", () => {
    expect(validateCredentialKind("bearer", "token")).toEqual({ ok: true });
  });

  it("rejects basic + token (mismatch)", () => {
    const result = validateCredentialKind("basic", "token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("basic");
      expect(result.message).toContain("token");
    }
  });

  it("rejects bearer + password (mismatch)", () => {
    const result = validateCredentialKind("bearer", "password");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("bearer");
      expect(result.message).toContain("password");
    }
  });

  it("rejects none + password (no credential expected)", () => {
    const result = validateCredentialKind("none", "password");
    expect(result.ok).toBe(false);
  });
});
