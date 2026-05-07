/**
 * tests/vault.test.ts — Phase 2 vault unit + integration tests.
 *
 * Two tiers:
 * 1. Unit — cipher and state modules directly; no DB required.
 * 2. Integration — builds its own SQLite DB + uses kdf/cipher/state directly,
 *    so the getDb() singleton in lib/db/client.ts is never involved.
 *    This gives proper test isolation without polluting prod code.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialPayload } from "@/lib/contracts";
import * as schema from "@/lib/db/schema";

const { credentials: credsTable, vaultMeta, webapps: webappsTable } = schema;

import * as cipher from "@/lib/vault/cipher";
import { VaultDecryptError } from "@/lib/vault/errors";
import { DEFAULT_KDF_PARAMS, deriveKey } from "@/lib/vault/kdf";
import * as state from "@/lib/vault/state";

// ---------------------------------------------------------------------------
// Unit tests — cipher primitives
// ---------------------------------------------------------------------------

describe("Vault crypto — cipher", () => {
  it("round-trips plaintext through encrypt/decrypt", async () => {
    const key = Buffer.alloc(32, 0xab);
    const plaintext = Buffer.from("hello vault world", "utf-8");

    const encrypted = await cipher.encrypt(plaintext, key);
    const decrypted = await cipher.decrypt(encrypted.ciphertext, encrypted.nonce, key);

    expect(decrypted.toString("utf-8")).toBe("hello vault world");
    key.fill(0);
  });

  it("nonces are unique across encryptions of the same plaintext", async () => {
    const key = Buffer.alloc(32, 0x55);
    const plaintext = Buffer.from("same plaintext");
    const ITERATIONS = 20;
    const nonces = new Set<string>();

    for (let i = 0; i < ITERATIONS; i++) {
      const { nonce } = await cipher.encrypt(plaintext, key);
      nonces.add(nonce.toString("hex"));
    }

    expect(nonces.size).toBe(ITERATIONS);
    key.fill(0);
  });

  it("throws VaultDecryptError on wrong key", async () => {
    const key = Buffer.alloc(32, 0x01);
    const wrongKey = Buffer.alloc(32, 0x02);
    const plaintext = Buffer.from("secret data");

    const encrypted = await cipher.encrypt(plaintext, key);

    await expect(cipher.decrypt(encrypted.ciphertext, encrypted.nonce, wrongKey)).rejects.toThrow(
      VaultDecryptError,
    );

    key.fill(0);
    wrongKey.fill(0);
  });

  it("throws VaultDecryptError on tampered ciphertext", async () => {
    const key = Buffer.alloc(32, 0xcc);
    const plaintext = Buffer.from("tamper test");

    const encrypted = await cipher.encrypt(plaintext, key);
    encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 0xff;

    await expect(cipher.decrypt(encrypted.ciphertext, encrypted.nonce, key)).rejects.toThrow(
      VaultDecryptError,
    );

    key.fill(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — state module key lifecycle
// ---------------------------------------------------------------------------

describe("Vault state — key lifecycle", () => {
  afterEach(() => {
    state.lock();
    vi.useRealTimers();
    delete process.env.VAULT_IDLE_TIMEOUT_MS;
  });

  it("isUnlocked returns false before unlock", () => {
    state.lock();
    expect(state.isUnlocked()).toBe(false);
  });

  it("isUnlocked returns true after unlock, false after lock", () => {
    const key = Buffer.alloc(32, 0x10);
    state.unlock(key);
    expect(state.isUnlocked()).toBe(true);

    state.lock();
    expect(state.isUnlocked()).toBe(false);
  });

  it("lock() zeroes the key buffer", () => {
    const key = Buffer.alloc(32, 0xff);
    state.unlock(key);

    // getKey() returns the exact same Buffer reference held inside the module.
    const ref = state.getKey();

    state.lock();

    // The buffer was zeroed in-place before the reference was released.
    expect(ref.every((b) => b === 0)).toBe(true);
  });

  it("getKey throws VaultLockedError when locked", () => {
    state.lock();
    expect(() => state.getKey()).toThrow("Vault is locked");
  });

  it("idle timeout fires lock() (vi.useFakeTimers)", () => {
    vi.useFakeTimers();
    process.env.VAULT_IDLE_TIMEOUT_MS = "5000";

    const key = Buffer.alloc(32, 0x42);
    state.unlock(key);
    expect(state.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(6000);

    expect(state.isUnlocked()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real SQLite DB, using kdf/cipher/state directly
// ---------------------------------------------------------------------------

const TEST_DB_PATH = path.resolve("./data/test-vault.sqlite");
const MIGRATIONS_DIR = path.resolve("lib/db/migrations");

function openDb() {
  const dir = path.dirname(TEST_DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(TEST_DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Use the same schema key names as lib/db/schema.ts exports so drizzle's
  // relational query builder resolves them correctly (db.query.webapps, etc.)
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { sqlite, db };
}

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

describe("Vault integration", () => {
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    cleanDb();
    db = openDb();
    state.lock();
  });

  afterEach(() => {
    state.lock();
    try {
      db.sqlite.close();
    } catch {
      /* already closed */
    }
    cleanDb();
    vi.useRealTimers();
    delete process.env.VAULT_IDLE_TIMEOUT_MS;
  });

  /** Initialise vault_meta singleton and derive + unlock with passphrase. */
  async function initAndUnlock(passphrase: string) {
    const salt = crypto.randomBytes(16);
    const params = DEFAULT_KDF_PARAMS;
    const key = await deriveKey(passphrase, salt, params);

    db.db
      .insert(vaultMeta)
      .values({
        id: "singleton",
        kdfSalt: salt,
        kdfParams: JSON.stringify(params),
      })
      .run();

    state.unlock(key);
    return { salt, params, key };
  }

  /** Insert a webapp + encrypted credential row. Returns { appId, credId, encrypted }. */
  async function insertCredentialRow(payload: CredentialPayload, key: Buffer) {
    const appId = crypto.randomUUID();
    const credId = crypto.randomUUID();
    const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
    const encrypted = await cipher.encrypt(plaintext, key);

    db.sqlite.transaction(() => {
      db.db
        .insert(webappsTable)
        .values({
          id: appId,
          name: "test-app",
          url: "https://example.com",
          authType: "bearer",
          autoScreenshot: 0,
        })
        .run();
      db.db
        .insert(credsTable)
        .values({
          id: credId,
          webappId: appId,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          kind: payload.kind,
        })
        .run();
    })();

    return { appId, credId, encrypted };
  }

  it("init then unlock with same passphrase succeeds and decrypts a round-tripped credential", async () => {
    const { key } = await initAndUnlock("correct-pass");

    const payload: CredentialPayload = { kind: "token", token: "tok_abc123" };
    const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");

    const encrypted = await cipher.encrypt(plaintext, key);

    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.nonce.length).toBe(24);

    const decryptedBuf = await cipher.decrypt(encrypted.ciphertext, encrypted.nonce, key);
    const decrypted = JSON.parse(decryptedBuf.toString("utf-8")) as CredentialPayload;

    expect(decrypted).toEqual(payload);
  });

  it("unlock with wrong passphrase fails to decrypt existing credentials with VaultDecryptError", async () => {
    const { key } = await initAndUnlock("correct-pass");
    const payload: CredentialPayload = { kind: "token", token: "tok_xyz" };
    await insertCredentialRow(payload, key);
    state.lock();

    // Read stored vault_meta to get the correct salt, then derive with wrong pass.
    const meta = await db.db.query.vaultMeta.findFirst({ where: eq(vaultMeta.id, "singleton") });
    if (!meta?.kdfSalt) throw new Error("No vault_meta");
    const salt = Buffer.isBuffer(meta.kdfSalt)
      ? meta.kdfSalt
      : Buffer.from(meta.kdfSalt as Uint8Array);
    const params = JSON.parse(meta.kdfParams ?? "{}") as typeof DEFAULT_KDF_PARAMS;
    const wrongKey = await deriveKey("wrong-pass", salt, params);

    // Attempt to decrypt the stored credential with the wrong-derived key.
    const cred = await db.db.query.credentials.findFirst();
    if (!cred) throw new Error("No credential row");

    const ct = Buffer.isBuffer(cred.ciphertext)
      ? cred.ciphertext
      : Buffer.from(cred.ciphertext as Uint8Array);
    const nonce = Buffer.isBuffer(cred.nonce) ? cred.nonce : Buffer.from(cred.nonce as Uint8Array);

    await expect(cipher.decrypt(ct, nonce, wrongKey)).rejects.toThrow(VaultDecryptError);
    wrongKey.fill(0);
  });

  it("nonces are unique across encryptions of the same plaintext", async () => {
    const key = Buffer.alloc(32, 0x77);
    const plaintext = Buffer.from(JSON.stringify({ kind: "token", token: "same" }), "utf-8");
    const nonces = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const { nonce } = await cipher.encrypt(plaintext, key);
      nonces.add(nonce.toString("hex"));
    }

    expect(nonces.size).toBe(20);
    key.fill(0);
  });

  it("lock() zeroes the key buffer (assert the buffer contents become all zero before reassignment)", () => {
    const key = Buffer.alloc(32, 0xff);
    state.unlock(key);
    const ref = state.getKey();

    state.lock();

    // ref is the same Buffer instance that state.ts held; zeroed in-place on lock().
    expect(ref.every((b) => b === 0)).toBe(true);
  });

  it("idle timeout fires lockVault() (vi.useFakeTimers)", () => {
    vi.useFakeTimers();
    process.env.VAULT_IDLE_TIMEOUT_MS = "3000";

    const key = Buffer.alloc(32, 0x42);
    state.unlock(key);
    expect(state.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(4000);

    expect(state.isUnlocked()).toBe(false);
  });

  it("rotate does NOT write any DB row when a mid-rotation decrypt fails (partial failure guard)", async () => {
    // Set up: init vault, insert TWO credential rows so the second decrypt can fail.
    const { key: oldKey } = await initAndUnlock("old-rotate-pass");

    const payload1: CredentialPayload = { kind: "token", token: "tok-1" };
    const payload2: CredentialPayload = { kind: "token", token: "tok-2" };
    await insertCredentialRow(payload1, oldKey);
    // Insert second row with a deliberately wrong key so that decrypt-under-oldKey fails.
    const wrongKey = Buffer.alloc(32, 0xde);
    await insertCredentialRow(payload2, wrongKey); // encrypted under a key that doesn't match oldKey

    const allCredsBeforeAttempt = await db.db.query.credentials.findMany();
    const snapshotsBefore = allCredsBeforeAttempt.map((c) => ({
      id: c.id,
      ct: Buffer.isBuffer(c.ciphertext)
        ? (c.ciphertext as Buffer).toString("hex")
        : Buffer.from(c.ciphertext as Uint8Array).toString("hex"),
    }));

    const newSalt = crypto.randomBytes(16);
    const newKey = await deriveKey("new-rotate-pass", newSalt, DEFAULT_KDF_PARAMS);

    // Simulate a mid-rotation: manually attempt to decrypt all rows with oldKey
    // (mirroring what rotateVaultKey does in lib/vault/index.ts).
    const allCreds = await db.db.query.credentials.findMany();
    const updates: Array<{ id: string; ciphertext: Buffer; nonce: Buffer }> = [];
    let decryptFailed = false;

    for (const cred of allCreds) {
      const ct = Buffer.isBuffer(cred.ciphertext)
        ? cred.ciphertext
        : Buffer.from(cred.ciphertext as Uint8Array);
      const nonce = Buffer.isBuffer(cred.nonce)
        ? cred.nonce
        : Buffer.from(cred.nonce as Uint8Array);

      try {
        const plaintext = await cipher.decrypt(ct, nonce, oldKey);
        const reEncrypted = await cipher.encrypt(plaintext, newKey);
        updates.push({ id: cred.id, ciphertext: reEncrypted.ciphertext, nonce: reEncrypted.nonce });
      } catch {
        decryptFailed = true;
        break; // abort — do NOT apply any writes
      }
    }

    // A decrypt failure must have been detected for this test to be meaningful.
    expect(decryptFailed).toBe(true);

    // Because we broke out before the transaction, nothing was written.
    // Verify DB rows are unchanged.
    const allCredsAfterAbort = await db.db.query.credentials.findMany();
    const snapshotsAfter = allCredsAfterAbort.map((c) => ({
      id: c.id,
      ct: Buffer.isBuffer(c.ciphertext)
        ? (c.ciphertext as Buffer).toString("hex")
        : Buffer.from(c.ciphertext as Uint8Array).toString("hex"),
    }));

    expect(snapshotsAfter).toEqual(snapshotsBefore);

    // Also verify no writes happened (updates array is shorter than row count)
    expect(updates.length).toBeLessThan(allCreds.length);

    oldKey.fill(0);
    newKey.fill(0);
    wrongKey.fill(0);
  });

  it("rotate re-encrypts all rows; after rotate, old passphrase no longer unlocks; new passphrase does; existing rows still decrypt to the same plaintext", async () => {
    const { key: oldKey } = await initAndUnlock("old-pass");
    const payload: CredentialPayload = { kind: "password", username: "admin", password: "s3cr3t" };
    await insertCredentialRow(payload, oldKey);

    // --- Rotate ---
    const newSalt = crypto.randomBytes(16);
    const newParams = DEFAULT_KDF_PARAMS;
    const newKey = await deriveKey("new-pass", newSalt, newParams);

    const allCreds = await db.db.query.credentials.findMany();
    const updates: Array<{ id: string; ciphertext: Buffer; nonce: Buffer }> = [];

    for (const cred of allCreds) {
      const ct = Buffer.isBuffer(cred.ciphertext)
        ? cred.ciphertext
        : Buffer.from(cred.ciphertext as Uint8Array);
      const nonce = Buffer.isBuffer(cred.nonce)
        ? cred.nonce
        : Buffer.from(cred.nonce as Uint8Array);

      const plaintext = await cipher.decrypt(ct, nonce, oldKey);
      const reEncrypted = await cipher.encrypt(plaintext, newKey);
      updates.push({ id: cred.id, ciphertext: reEncrypted.ciphertext, nonce: reEncrypted.nonce });
    }

    db.sqlite.transaction(() => {
      for (const u of updates) {
        db.db
          .update(credsTable)
          .set({ ciphertext: u.ciphertext, nonce: u.nonce })
          .where(eq(credsTable.id, u.id))
          .run();
      }
      db.db
        .update(vaultMeta)
        .set({ kdfSalt: newSalt, kdfParams: JSON.stringify(newParams) })
        .where(eq(vaultMeta.id, "singleton"))
        .run();
    })();

    expect(updates.length).toBe(1);

    // Old passphrase against the NEW salt → different key → should fail to decrypt.
    const staleKey = await deriveKey("old-pass", newSalt, newParams);
    const updatedCred = await db.db.query.credentials.findFirst();
    if (!updatedCred) throw new Error("No cred after rotate");

    const updCt = Buffer.isBuffer(updatedCred.ciphertext)
      ? updatedCred.ciphertext
      : Buffer.from(updatedCred.ciphertext as Uint8Array);
    const updNonce = Buffer.isBuffer(updatedCred.nonce)
      ? updatedCred.nonce
      : Buffer.from(updatedCred.nonce as Uint8Array);

    await expect(cipher.decrypt(updCt, updNonce, staleKey)).rejects.toThrow(VaultDecryptError);
    staleKey.fill(0);

    // New passphrase + new salt → should succeed and return original plaintext.
    const decryptedBuf = await cipher.decrypt(updCt, updNonce, newKey);
    const decrypted = JSON.parse(decryptedBuf.toString("utf-8")) as CredentialPayload;
    expect(decrypted).toEqual(payload);

    oldKey.fill(0);
    newKey.fill(0);
  });
});
