/**
 * lib/vault/index.ts — public API for the credential vault.
 *
 * This is the ONLY module that API routes should import from.
 * The kdf, cipher, state, and errors sub-modules are implementation details.
 *
 * SECURITY BOUNDARY:
 * - The derived key Buffer NEVER leaves this module.
 * - All plaintext payloads are JSON-encoded immediately before encryption and
 *   decoded immediately after decryption — they are not cached anywhere.
 * - Any function that touches the key is async so the JS event loop is not
 *   blocked while Argon2id runs.
 *
 * RE-EXPORT ERRORS so callers can import from a single location.
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { CredentialPayload } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { credentials, vaultMeta } from "@/lib/db/schema";
import * as cipher from "./cipher";
import { VaultDecryptError, VaultNotInitError } from "./errors";
import { DEFAULT_KDF_PARAMS, deriveKey, type KdfParams } from "./kdf";
import * as state from "./state";

export {
  VaultAlreadyInitError,
  VaultDecryptError,
  VaultLockedError,
  VaultNotInitError,
} from "./errors";

// ---------------------------------------------------------------------------
// Vault initialisation
// ---------------------------------------------------------------------------

/**
 * Returns true if vault_meta has a singleton row with a kdfSalt set.
 * Does NOT indicate whether the vault is currently unlocked.
 */
export async function isVaultInitialised(): Promise<boolean> {
  const db = getDb();
  const row = await db.query.vaultMeta.findFirst({
    where: eq(vaultMeta.id, "singleton"),
  });
  return row !== undefined && row.kdfSalt !== null;
}

/**
 * Ensure the vault_meta singleton row exists (upsert with no salt yet).
 * Called at startup if needed. Safe to call multiple times.
 */
export async function initVaultIfNeeded(): Promise<void> {
  const db = getDb();
  const existing = await db.query.vaultMeta.findFirst({
    where: eq(vaultMeta.id, "singleton"),
  });
  if (!existing) {
    await db.insert(vaultMeta).values({ id: "singleton" });
  }
}

// ---------------------------------------------------------------------------
// Unlock (handles both init and re-unlock)
// ---------------------------------------------------------------------------

/**
 * Unlock the vault.
 *
 * If the vault has never been initialised (no kdfSalt in vault_meta), this
 * call generates a fresh salt + default params, stores them, derives the key,
 * and marks the vault unlocked. Status: "initialised".
 *
 * If the vault has been initialised, derives the key with stored params and:
 * - If there are existing credential rows, attempts to decrypt the first one
 *   to verify the passphrase. Throws VaultDecryptError on wrong passphrase.
 * - If there are no existing credential rows, stores the key directly
 *   (first wrong-passphrase detection will happen on the first decrypt attempt).
 * Status: "unlocked".
 *
 * @throws VaultDecryptError  Wrong passphrase (existing vault with credentials).
 */
export async function unlockVault(
  passphrase: string,
): Promise<{ status: "unlocked" | "initialised" }> {
  const db = getDb();

  // Ensure the singleton row exists.
  await initVaultIfNeeded();

  const meta = await db.query.vaultMeta.findFirst({
    where: eq(vaultMeta.id, "singleton"),
  });

  if (!meta?.kdfSalt) {
    // First-time initialisation.
    const salt = crypto.randomBytes(16);
    const params = DEFAULT_KDF_PARAMS;

    await db
      .update(vaultMeta)
      .set({
        kdfSalt: salt,
        kdfParams: JSON.stringify(params),
      })
      .where(eq(vaultMeta.id, "singleton"));

    const key = await deriveKey(passphrase, salt, params);
    state.unlock(key);
    return { status: "initialised" };
  }

  // Re-unlock existing vault.
  const params: KdfParams = JSON.parse(meta.kdfParams ?? "{}") as KdfParams;
  const salt = Buffer.isBuffer(meta.kdfSalt)
    ? meta.kdfSalt
    : Buffer.from(meta.kdfSalt as Uint8Array);

  const key = await deriveKey(passphrase, salt, params);

  // Verify against an existing credential row if any exist.
  const firstCred = await db.query.credentials.findFirst();
  if (firstCred) {
    const ct = Buffer.isBuffer(firstCred.ciphertext)
      ? firstCred.ciphertext
      : Buffer.from(firstCred.ciphertext as Uint8Array);
    const nonce = Buffer.isBuffer(firstCred.nonce)
      ? firstCred.nonce
      : Buffer.from(firstCred.nonce as Uint8Array);

    try {
      await cipher.decrypt(ct, nonce, key);
    } catch {
      // Zero the candidate key before throwing.
      key.fill(0);
      throw new VaultDecryptError();
    }
  }

  state.unlock(key);
  return { status: "unlocked" };
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export function lockVault(): { status: "locked" } {
  state.lock();
  return { status: "locked" };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function vaultStatus(): Promise<{
  initialised: boolean;
  unlocked: boolean;
  idleTimeoutMs: number;
}> {
  return {
    initialised: await isVaultInitialised(),
    unlocked: state.isUnlocked(),
    idleTimeoutMs: state.getIdleTimeoutMsExported(),
  };
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt credential payloads
// ---------------------------------------------------------------------------

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Encrypt a CredentialPayload under the current vault key.
 * The payload is JSON-encoded to bytes immediately before encryption.
 *
 * @throws VaultLockedError  If vault is not unlocked.
 */
export async function encryptCredential(payload: CredentialPayload): Promise<EncryptedCredential> {
  const key = state.getKey(); // throws VaultLockedError if locked
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const result = await cipher.encrypt(plaintext, key);
  return result;
}

/**
 * Decrypt a stored credential record back to a CredentialPayload.
 *
 * @throws VaultLockedError    If vault is not unlocked.
 * @throws VaultDecryptError   If MAC verification fails (wrong key or tampered data).
 */
export async function decryptCredential(
  encrypted: EncryptedCredential,
): Promise<CredentialPayload> {
  const key = state.getKey(); // throws VaultLockedError if locked
  const plaintext = await cipher.decrypt(encrypted.ciphertext, encrypted.nonce, key);
  const payload = JSON.parse(plaintext.toString("utf-8")) as CredentialPayload;
  return payload;
}

// ---------------------------------------------------------------------------
// Key rotation
// ---------------------------------------------------------------------------

/**
 * Re-encrypt all credentials from oldPassphrase to newPassphrase.
 * Fully transactional — if any row fails, rolls back.
 *
 * @throws VaultDecryptError  If oldPassphrase is wrong.
 * @throws VaultNotInitError  If vault has not been initialised.
 */
export async function rotateVaultKey(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<{ status: "rotated"; recordsReencrypted: number }> {
  const db = getDb();

  const meta = await db.query.vaultMeta.findFirst({
    where: eq(vaultMeta.id, "singleton"),
  });

  if (!meta?.kdfSalt) {
    throw new VaultNotInitError();
  }

  const params: KdfParams = JSON.parse(meta.kdfParams ?? "{}") as KdfParams;
  const salt = Buffer.isBuffer(meta.kdfSalt)
    ? meta.kdfSalt
    : Buffer.from(meta.kdfSalt as Uint8Array);

  const oldKey = await deriveKey(oldPassphrase, salt, params);

  // Derive new key with fresh salt.
  const newSalt = crypto.randomBytes(16);
  const newParams = DEFAULT_KDF_PARAMS;
  const newKey = await deriveKey(newPassphrase, newSalt, newParams);

  try {
    const allCreds = await db.query.credentials.findMany();

    // Decrypt all rows under the old key, re-encrypt under the new key.
    // Collect updates before writing — any decrypt failure aborts the whole op.
    const updates: Array<{ id: string; ciphertext: Buffer; nonce: Buffer }> = [];

    for (const cred of allCreds) {
      const ct = Buffer.isBuffer(cred.ciphertext)
        ? cred.ciphertext
        : Buffer.from(cred.ciphertext as Uint8Array);
      const nonce = Buffer.isBuffer(cred.nonce)
        ? cred.nonce
        : Buffer.from(cred.nonce as Uint8Array);

      let plaintext: Buffer;
      try {
        plaintext = await cipher.decrypt(ct, nonce, oldKey);
      } catch {
        throw new VaultDecryptError();
      }

      const reEncrypted = await cipher.encrypt(plaintext, newKey);
      updates.push({ id: cred.id, ciphertext: reEncrypted.ciphertext, nonce: reEncrypted.nonce });
    }

    // Apply all updates in a single SQLite transaction.
    const sqlite = db.$client as import("better-sqlite3").Database;
    const applyUpdates = sqlite.transaction(() => {
      for (const u of updates) {
        db.update(credentials)
          .set({ ciphertext: u.ciphertext, nonce: u.nonce })
          .where(eq(credentials.id, u.id))
          .run();
      }

      // Swap vault_meta to new salt/params.
      db.update(vaultMeta)
        .set({ kdfSalt: newSalt, kdfParams: JSON.stringify(newParams) })
        .where(eq(vaultMeta.id, "singleton"))
        .run();
    });

    applyUpdates();

    // Update the in-process key.
    state.unlock(newKey);

    return { status: "rotated", recordsReencrypted: updates.length };
  } finally {
    oldKey.fill(0);
    // newKey is now owned by state.ts; do NOT zero it here.
  }
}
