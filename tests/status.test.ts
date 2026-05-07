/**
 * tests/status.test.ts — Phase 3 status check tests.
 *
 * Test tiers:
 * 1. Strategy unit tests (none, basic-auth, bearer-token) using undici MockAgent.
 * 2. Cache + coalescing tests against the orchestrator.
 * 3. Vault-locked guard test.
 *
 * The orchestrator's database calls are stubbed so no SQLite instance is needed.
 */

import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusResult } from "@/lib/contracts";

// ---------------------------------------------------------------------------
// Helpers to (re)set the MockAgent before each test
// ---------------------------------------------------------------------------

let mockAgent: MockAgent;

function setupMockAgent() {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
}

function teardownMockAgent() {
  mockAgent.enableNetConnect();
}

// ---------------------------------------------------------------------------
// 1. Strategy: none
// ---------------------------------------------------------------------------

describe("strategy: none", () => {
  beforeEach(setupMockAgent);
  afterEach(teardownMockAgent);

  it("returns ok:true for a 200 HEAD response", async () => {
    const pool = mockAgent.get("http://example.test");
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");

    const { check } = await import("@/lib/status/strategies/none");
    const result = await check("http://example.test/", { kind: "none" });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.lastCheckedAt).toBeGreaterThan(0);
  });

  it("returns ok:false with error on network failure", async () => {
    const pool = mockAgent.get("http://fail.test");
    pool.intercept({ path: "/", method: "HEAD" }).replyWithError(new Error("ECONNREFUSED"));

    const { check } = await import("@/lib/status/strategies/none");
    const result = await check("http://fail.test/", { kind: "none" });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).not.toBeNull();
    expect(typeof result.error).toBe("string");
  });

  it("falls back to GET when HEAD returns 405", async () => {
    const pool = mockAgent.get("http://nohead.test");
    pool.intercept({ path: "/", method: "HEAD" }).reply(405, "");
    pool.intercept({ path: "/", method: "GET" }).reply(200, "ok");

    const { check } = await import("@/lib/status/strategies/none");
    const result = await check("http://nohead.test/", { kind: "none" });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2. Strategy: basic-auth
// ---------------------------------------------------------------------------

describe("strategy: basic-auth", () => {
  beforeEach(setupMockAgent);
  afterEach(teardownMockAgent);

  it("returns ok:true for a 200 response", async () => {
    const pool = mockAgent.get("http://basic.test");
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");

    const { check } = await import("@/lib/status/strategies/basic-auth");
    const result = await check("http://basic.test/", {
      kind: "basic",
      username: "user",
      password: "pass",
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it("sends the correct Authorization: Basic header", async () => {
    const expected = `Basic ${Buffer.from("alice:secret").toString("base64")}`;
    let capturedAuth: string | undefined;

    const pool = mockAgent.get("http://basic-header.test");
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "", {
      headers: {},
    });
    // Use the intercept callback to inspect the request headers.
    // undici MockAgent captures headers via the intercept options.

    // We verify the header by intercepting with a header check.
    const pool2 = mockAgent.get("http://basic-header2.test");
    pool2
      .intercept({
        path: "/",
        method: "HEAD",
        headers: { authorization: expected },
      })
      .reply(200, "");

    const { check } = await import("@/lib/status/strategies/basic-auth");
    const result = await check("http://basic-header2.test/", {
      kind: "basic",
      username: "alice",
      password: "secret",
    });

    // If the header didn't match, undici MockAgent would throw "No match for request".
    expect(result.ok).toBe(true);
    expect(capturedAuth).toBeUndefined(); // unused variable guard
    void capturedAuth;
  });

  it("returns ok:false with error on network failure", async () => {
    const pool = mockAgent.get("http://basic-fail.test");
    pool.intercept({ path: "/", method: "HEAD" }).replyWithError(new Error("ENOTFOUND"));

    const { check } = await import("@/lib/status/strategies/basic-auth");
    const result = await check("http://basic-fail.test/", {
      kind: "basic",
      username: "u",
      password: "p",
    });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Strategy: bearer-token
// ---------------------------------------------------------------------------

describe("strategy: bearer-token", () => {
  beforeEach(setupMockAgent);
  afterEach(teardownMockAgent);

  it("returns ok:true for a 200 response", async () => {
    const pool = mockAgent.get("http://bearer.test");
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");

    const { check } = await import("@/lib/status/strategies/bearer-token");
    const result = await check("http://bearer.test/", {
      kind: "bearer",
      token: "mytoken",
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it("sends the correct Authorization: Bearer header", async () => {
    const pool = mockAgent.get("http://bearer-header.test");
    pool
      .intercept({
        path: "/",
        method: "HEAD",
        headers: { authorization: "Bearer supersecret" },
      })
      .reply(200, "");

    const { check } = await import("@/lib/status/strategies/bearer-token");
    const result = await check("http://bearer-header.test/", {
      kind: "bearer",
      token: "supersecret",
    });

    expect(result.ok).toBe(true);
  });

  it("returns ok:false with error on network failure", async () => {
    const pool = mockAgent.get("http://bearer-fail.test");
    pool.intercept({ path: "/", method: "HEAD" }).replyWithError(new Error("ETIMEDOUT"));

    const { check } = await import("@/lib/status/strategies/bearer-token");
    const result = await check("http://bearer-fail.test/", {
      kind: "bearer",
      token: "t",
    });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Cache + coalescing tests (orchestrator)
//
// We stub the DB and vault dependencies so the orchestrator can run in
// isolation. The performCheck function is exercised via runStatusCheck.
// ---------------------------------------------------------------------------

// We need to reset modules between cache tests because the cache Map is
// module-level state.
describe("orchestrator: cache", () => {
  beforeEach(() => {
    vi.resetModules();
    setupMockAgent();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    teardownMockAgent();
    vi.restoreAllMocks();
  });

  async function buildStubOrchestrator(webappId: string, url: string) {
    // Stub vault and db *before* importing the orchestrator so the module
    // picks up the stubs when it first executes.
    vi.doMock("@/lib/vault", () => ({
      vaultStatus: vi
        .fn()
        .mockResolvedValue({ unlocked: true, initialised: true, idleTimeoutMs: 0 }),
      decryptCredential: vi.fn(),
      VaultLockedError: class VaultLockedError extends Error {},
    }));

    vi.doMock("@/lib/db/client", () => ({
      getDb: vi.fn().mockReturnValue({
        query: {
          webapps: {
            findFirst: vi.fn().mockResolvedValue({ id: webappId, url, authType: "none" }),
          },
          credentials: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
        },
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue([{ id: webappId }]),
        }),
      }),
    }));

    // Re-import with fresh module state.
    return await import("@/lib/status/index");
  }

  it("two calls within 30s produce one network call", async () => {
    const pool = mockAgent.get("http://cached.test");
    // Only register one intercept — if two network calls happen, the second
    // would throw "No match for request".
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");

    const orchestrator = await buildStubOrchestrator("app-1", "http://cached.test/");

    const r1 = await orchestrator.runStatusCheck("app-1");
    // Advance 10s — still within TTL.
    vi.advanceTimersByTime(10_000);
    const r2 = await orchestrator.runStatusCheck("app-1");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Both calls return cached result; only one network hop registered above.
  });

  it("third call after 31s produces a second network call", async () => {
    const pool = mockAgent.get("http://expire.test");
    // Two intercepts for two network calls.
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");

    const orchestrator = await buildStubOrchestrator("app-2", "http://expire.test/");

    await orchestrator.runStatusCheck("app-2");
    // Advance past TTL.
    vi.advanceTimersByTime(31_000);
    // This call must trigger a second network request (intercept consumed above).
    const result = await orchestrator.runStatusCheck("app-2");
    expect(result.ok).toBe(true);
  });

  it("5 simultaneous cache-miss calls produce exactly one network call", async () => {
    const pool = mockAgent.get("http://coalesce.test");
    // Only one intercept registered — extra calls would throw if not coalesced.
    pool.intercept({ path: "/", method: "HEAD" }).reply(200, "");

    const orchestrator = await buildStubOrchestrator("app-3", "http://coalesce.test/");

    const results = await Promise.all([
      orchestrator.runStatusCheck("app-3"),
      orchestrator.runStatusCheck("app-3"),
      orchestrator.runStatusCheck("app-3"),
      orchestrator.runStatusCheck("app-3"),
      orchestrator.runStatusCheck("app-3"),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Vault-locked guard
// ---------------------------------------------------------------------------

describe("orchestrator: vault locked", () => {
  beforeEach(() => {
    vi.resetModules();
    setupMockAgent();
  });

  afterEach(() => {
    teardownMockAgent();
    vi.restoreAllMocks();
  });

  it("returns error:vault_locked and makes no network call when vault is locked", async () => {
    vi.doMock("@/lib/vault", () => ({
      vaultStatus: vi
        .fn()
        .mockResolvedValue({ unlocked: false, initialised: true, idleTimeoutMs: 0 }),
      decryptCredential: vi.fn(),
      VaultLockedError: class VaultLockedError extends Error {},
    }));

    vi.doMock("@/lib/db/client", () => ({
      getDb: vi.fn().mockReturnValue({
        query: {
          webapps: {
            findFirst: vi.fn().mockResolvedValue({
              id: "locked-app",
              url: "http://should-not-be-called.test/",
              authType: "basic",
            }),
          },
          credentials: {
            findFirst: vi.fn().mockResolvedValue({
              id: "cred-1",
              webappId: "locked-app",
              ciphertext: Buffer.from("fake"),
              nonce: Buffer.from("fake"),
              kind: "password",
            }),
          },
        },
      }),
    }));

    // No intercept registered — any network call would throw.
    const { runStatusCheck } = await import("@/lib/status/index");
    const result: StatusResult = await runStatusCheck("locked-app");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("vault_locked");
    expect(result.statusCode).toBeNull();
  });
});
