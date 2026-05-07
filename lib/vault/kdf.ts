/**
 * lib/vault/kdf.ts — Argon2id key derivation.
 *
 * Uses @node-rs/argon2 `hashRaw`. Parameters are committed constants so the
 * cost profile is visible to any auditor reading this file.
 *
 * SECURITY NOTES:
 * - hashRaw returns the raw derived bytes — no encoding overhead.
 * - salt must be generated with crypto.randomBytes(16) at vault init time.
 * - The returned Buffer holds the master encryption key. Callers MUST zero it
 *   (key.fill(0)) when they are done. lib/vault/state.ts handles this.
 * - Params are also stored in vault_meta.kdfParams so that we can bump them
 *   in a future migration without breaking existing installs.
 */

import { hashRaw } from "@node-rs/argon2";

/** Argon2id cost parameters. */
export interface KdfParams {
  /** Memory cost in KiB. 65536 = 64 MiB. */
  m: number;
  /** Time cost (iterations). */
  t: number;
  /** Parallelism degree. */
  p: number;
}

/** Default parameters committed at project inception (2026-05). */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  m: 65536, // 64 MiB
  t: 3,
  p: 4,
};

/**
 * Derive a 32-byte key from `passphrase` using Argon2id.
 *
 * @param passphrase  The user-supplied master passphrase (UTF-8 string).
 * @param salt        16-byte random salt stored in vault_meta.kdfSalt.
 * @param params      Argon2id cost parameters stored in vault_meta.kdfParams.
 * @returns           32-byte derived key as a Buffer. MUST be zeroed when done.
 */
export async function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: KdfParams,
): Promise<Buffer> {
  const raw = await hashRaw(passphrase, {
    salt,
    memoryCost: params.m,
    timeCost: params.t,
    parallelism: params.p,
    outputLen: 32,
  });
  return Buffer.from(raw);
}
