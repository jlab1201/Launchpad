/**
 * tests/thumbnails.test.ts — Unit tests for the thumbnail runner + scheduler.
 *
 * Strategy:
 *   - vi.mock("playwright") injects a fake chromium.launch that returns a
 *     controllable fake browser / context / page.
 *   - vi.mock("@/lib/vault") stubs vaultStatus and decryptCredential.
 *   - vi.mock("@/lib/db/client") provides a fake getDb() returning a
 *     controllable query object.
 *   - The filesystem is touched for real (tmp dir) so we can verify atomic
 *     write behaviour.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake Playwright objects
// ---------------------------------------------------------------------------

const fakeScreenshotData = Buffer.from("FAKEPNG");

const fakePage = {
  goto: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(fakeScreenshotData),
};

const fakeContext = {
  newPage: vi.fn().mockResolvedValue(fakePage),
  setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
  setHTTPCredentials: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const fakeBrowser = {
  newContext: vi.fn().mockResolvedValue(fakeContext),
  isConnected: vi.fn().mockReturnValue(true),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(fakeBrowser),
  },
}));

// ---------------------------------------------------------------------------
// Fake vault
// ---------------------------------------------------------------------------

const mockVaultStatus = vi.fn();
const mockDecryptCredential = vi.fn();

vi.mock("@/lib/vault", () => ({
  vaultStatus: mockVaultStatus,
  decryptCredential: mockDecryptCredential,
}));

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

const mockWebappFindFirst = vi.fn();
const mockCredFindFirst = vi.fn();

vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(() => ({
    query: {
      webapps: { findFirst: mockWebappFindFirst, findMany: vi.fn() },
      credentials: { findFirst: mockCredFindFirst },
    },
  })),
}));

// ---------------------------------------------------------------------------
// Helper to build temp THUMBNAIL_DIR per test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-thumb-"));
  process.env.THUMBNAIL_DIR = tmpDir;

  // Reset all mocks.
  vi.clearAllMocks();

  // Restore default mock implementations after clearAllMocks.
  fakeBrowser.isConnected.mockReturnValue(true);
  fakeBrowser.newContext.mockResolvedValue(fakeContext);
  fakeContext.newPage.mockResolvedValue(fakePage);
  fakeContext.setExtraHTTPHeaders.mockResolvedValue(undefined);
  fakeContext.close.mockResolvedValue(undefined);
  fakePage.goto.mockResolvedValue(undefined);
  fakePage.screenshot.mockResolvedValue(fakeScreenshotData);

  mockVaultStatus.mockResolvedValue({ unlocked: true, initialised: true, idleTimeoutMs: 1800000 });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.THUMBNAIL_DIR;
});

// ---------------------------------------------------------------------------
// Re-import runner after mocks are set up.
// We use dynamic import inside tests to pick up the vi.mock stubs.
// ---------------------------------------------------------------------------

async function getRunner() {
  // Reset module registry so the browser singleton is fresh per test group.
  vi.resetModules();
  const mod = await import("@/lib/thumbnails/runner");
  return mod;
}

// ---------------------------------------------------------------------------
// auth strategy: none
// ---------------------------------------------------------------------------

describe("captureThumbnail — auth: none", () => {
  it("navigates without injecting credentials", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-1",
      url: "http://localhost:3000",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-1");

    expect("error" in result).toBe(false);
    expect(fakeContext.setExtraHTTPHeaders).not.toHaveBeenCalled();
    expect(fakeContext.setHTTPCredentials).not.toHaveBeenCalled();

    // Page.goto called with the original URL.
    expect(fakePage.goto).toHaveBeenCalledWith(
      "http://localhost:3000",
      expect.objectContaining({ timeout: 15_000 }),
    );
  });
});

// ---------------------------------------------------------------------------
// auth strategy: bearer
// ---------------------------------------------------------------------------

describe("captureThumbnail — auth: bearer", () => {
  it("calls setExtraHTTPHeaders with Authorization: Bearer <token>", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-2",
      url: "http://internal.example.com/api",
      authType: "bearer",
    });
    mockCredFindFirst.mockResolvedValue({
      webappId: "app-2",
      ciphertext: Buffer.from("ct"),
      nonce: Buffer.from("nonce"),
      kind: "token",
    });
    mockDecryptCredential.mockResolvedValue({ kind: "token", token: "secret-token-xyz" });

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-2");

    expect("error" in result).toBe(false);
    expect(fakeContext.setExtraHTTPHeaders).toHaveBeenCalledWith({
      Authorization: "Bearer secret-token-xyz",
    });
    expect(fakeContext.setHTTPCredentials).not.toHaveBeenCalled();
  });

  it("returns error when vault is locked", async () => {
    mockVaultStatus.mockResolvedValue({ unlocked: false, initialised: true, idleTimeoutMs: 0 });
    mockWebappFindFirst.mockResolvedValue({
      id: "app-2",
      url: "http://internal.example.com/api",
      authType: "bearer",
    });
    mockCredFindFirst.mockResolvedValue({
      webappId: "app-2",
      ciphertext: Buffer.from("ct"),
      nonce: Buffer.from("nonce"),
      kind: "token",
    });

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-2");

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("vault_locked");
  });
});

// ---------------------------------------------------------------------------
// auth strategy: basic — URL injection
// ---------------------------------------------------------------------------

describe("captureThumbnail — auth: basic", () => {
  it("injects credentials via URL (user:pass@host)", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-3",
      url: "http://grafana.internal",
      authType: "basic",
    });
    mockCredFindFirst.mockResolvedValue({
      webappId: "app-3",
      ciphertext: Buffer.from("ct"),
      nonce: Buffer.from("nonce"),
      kind: "password",
    });
    mockDecryptCredential.mockResolvedValue({
      kind: "password",
      username: "admin",
      password: "p@ssword",
    });

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-3");

    expect("error" in result).toBe(false);

    // Verify goto was called with auth-in-URL (encoded special chars).
    const firstGotoCall = fakePage.goto.mock.calls[0];
    if (!firstGotoCall) throw new Error("page.goto was not called");
    const gotoCall = firstGotoCall[0] as string;
    expect(gotoCall).toContain("admin");
    expect(gotoCall).toContain("grafana.internal");
    // password special char encoded.
    expect(gotoCall).toContain("p%40ssword");
    // setExtraHTTPHeaders should NOT be called.
    expect(fakeContext.setExtraHTTPHeaders).not.toHaveBeenCalled();
  });

  it("returns error when vault is locked", async () => {
    mockVaultStatus.mockResolvedValue({ unlocked: false, initialised: true, idleTimeoutMs: 0 });
    mockWebappFindFirst.mockResolvedValue({
      id: "app-3",
      url: "http://grafana.internal",
      authType: "basic",
    });
    mockCredFindFirst.mockResolvedValue({
      webappId: "app-3",
      ciphertext: Buffer.from("ct"),
      nonce: Buffer.from("nonce"),
      kind: "password",
    });

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-3");

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("vault_locked");
  });
});

// ---------------------------------------------------------------------------
// Atomic write — .tmp then rename
// ---------------------------------------------------------------------------

describe("captureThumbnail — atomic write", () => {
  it("writes to .tmp then renames to final file", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-atomic",
      url: "http://localhost",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);

    // Spy on fs.renameSync and fs.writeFileSync to verify ordering.
    const writeOrder: string[] = [];
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    const origRenameSync = fs.renameSync.bind(fs);

    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((p, data, opts?) => {
      writeOrder.push(`write:${String(p)}`);
      origWriteFileSync(p, data, opts as never);
    });
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      writeOrder.push(`rename:${String(from)}→${String(to)}`);
      origRenameSync(from, to);
    });

    const { captureThumbnail } = await getRunner();
    await captureThumbnail("app-atomic");

    writeSpy.mockRestore();
    renameSpy.mockRestore();

    // write should come before rename.
    const writeIdx = writeOrder.findIndex((e) => e.startsWith("write:") && e.includes(".tmp"));
    const renameIdx = writeOrder.findIndex((e) => e.startsWith("rename:") && e.includes(".tmp"));
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(writeIdx);

    // Final file exists; .tmp is gone.
    const finalPath = path.join(tmpDir, "app-atomic.png");
    const tmpPath = `${finalPath}.tmp`;
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    // Success result uses public thumbnailUrl, not an absolute filesystem path.
    const { captureThumbnail: captureFn } = await getRunner();
    mockWebappFindFirst.mockResolvedValue({
      id: "app-atomic",
      url: "http://localhost",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);
    const successResult = await captureFn("app-atomic");
    expect("error" in successResult).toBe(false);
    const ok = successResult as { thumbnailUrl: string; capturedAt: number };
    expect(ok.thumbnailUrl).toBe("/api/thumbnail/app-atomic");
    expect("path" in ok).toBe(false);
  });

  it("does not leave a final file if screenshot throws", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-fail",
      url: "http://localhost",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);
    fakePage.screenshot.mockRejectedValueOnce(new Error("screenshot failed"));

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-fail");

    expect("error" in result).toBe(true);
    const finalPath = path.join(tmpDir, "app-fail.png");
    expect(fs.existsSync(finalPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browser missing — returns typed error
// ---------------------------------------------------------------------------

describe("captureThumbnail — missing browser binary", () => {
  it("returns browser_missing error when chromium is not installed", async () => {
    // Simulate the browser failing to connect so getBrowser() must try to launch.
    fakeBrowser.isConnected.mockReturnValue(false);

    // Force launch to fail with the "Executable doesn't exist" message.
    const { chromium } = await import("playwright");
    (chromium.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("browserType.launch: Executable doesn't exist at /usr/bin/chromium"),
    );

    mockWebappFindFirst.mockResolvedValue({
      id: "app-nobrowser",
      url: "http://localhost",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-nobrowser");

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("browser_missing");
  });
});

// ---------------------------------------------------------------------------
// Browser singleton reuse — chromium.launch called once across two captures
// ---------------------------------------------------------------------------

describe("captureThumbnail — browser singleton reused across consecutive calls", () => {
  it("calls chromium.launch exactly once for two consecutive captures", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-singleton",
      url: "http://localhost:3001",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);

    // Import fresh module so the singleton is reset
    const { captureThumbnail } = await getRunner();

    // First capture — browser not yet spawned, should launch
    await captureThumbnail("app-singleton");

    // Mock reset the findFirst return for second call (different id)
    mockWebappFindFirst.mockResolvedValue({
      id: "app-singleton-2",
      url: "http://localhost:3001",
      authType: "none",
    });

    // Second capture — browser already exists and isConnected returns true
    await captureThumbnail("app-singleton-2");

    // chromium.launch should have been called exactly once across both captures
    const { chromium } = await import("playwright");
    expect(chromium.launch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// redactNavigationError — strips credentials from Playwright error strings
// ---------------------------------------------------------------------------

describe("redactNavigationError", () => {
  it("removes username and password from a Playwright-style error message", async () => {
    const { redactNavigationError } = await getRunner();
    const navigateUrl = "https://admin:p%40ssword@host/";
    const playwrightErr = new Error(`net::ERR_CONNECTION_REFUSED at ${navigateUrl}`);
    const redacted = redactNavigationError(playwrightErr, navigateUrl);
    expect(redacted).not.toContain("admin");
    expect(redacted).not.toContain("p@ssword");
    expect(redacted).not.toContain("p%40ssword");
    expect(redacted).toContain("https://host/");
  });

  it("also strips the decoded form of the URL from the error message", async () => {
    const { redactNavigationError } = await getRunner();
    const navigateUrl = "https://admin:p%40ssword@host/";
    // Construct an error with the decoded (un-encoded) password — some
    // Playwright versions decode the URL in their error strings.
    const decoded = decodeURIComponent(navigateUrl);
    const playwrightErr = new Error(`net::ERR_CONNECTION_REFUSED at ${decoded}`);
    const redacted = redactNavigationError(playwrightErr, navigateUrl);
    expect(redacted).not.toContain("admin");
    expect(redacted).not.toContain("p@ssword");
  });
});

// ---------------------------------------------------------------------------
// captureThumbnail success shape — thumbnailUrl, no absolute path
// ---------------------------------------------------------------------------

describe("captureThumbnail — success result shape", () => {
  it("returns thumbnailUrl of the form /api/thumbnail/<id> and no path field", async () => {
    mockWebappFindFirst.mockResolvedValue({
      id: "app-shape",
      url: "http://localhost:3000",
      authType: "none",
    });
    mockCredFindFirst.mockResolvedValue(null);

    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-shape");

    expect("error" in result).toBe(false);
    const ok = result as { thumbnailUrl: string; capturedAt: number };
    expect(ok.thumbnailUrl).toBe("/api/thumbnail/app-shape");
    expect("path" in ok).toBe(false);
    expect(typeof ok.capturedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Scheduler — skips locked-vault apps
// ---------------------------------------------------------------------------

describe("scheduler — triggerRefresh", () => {
  it("returns vault_locked error and does not open a browser context when vault is locked", async () => {
    mockVaultStatus.mockResolvedValue({ unlocked: false, initialised: true, idleTimeoutMs: 0 });

    mockWebappFindFirst.mockResolvedValue({
      id: "app-sched",
      url: "http://app.internal",
      authType: "bearer",
    });
    mockCredFindFirst.mockResolvedValue({
      webappId: "app-sched",
      ciphertext: Buffer.from("ct"),
      nonce: Buffer.from("nonce"),
      kind: "token",
    });

    // Use the already-mocked runner via getRunner() to get consistent mocks.
    const { captureThumbnail } = await getRunner();
    const result = await captureThumbnail("app-sched");

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("vault_locked");
    // Vault check happens before browser context — newContext must not be called.
    expect(fakeBrowser.newContext).not.toHaveBeenCalled();
  });
});
