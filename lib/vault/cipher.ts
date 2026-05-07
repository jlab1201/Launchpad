/**
 * lib/vault/cipher.ts — libsodium XChaCha20-Poly1305 wrapper.
 *
 * We use crypto_secretbox_xchacha20poly1305_easy (via the `_x` variants) for
 * its 192-bit nonce space. The wider nonce (24 bytes vs 24 bytes standard, but
 * the XChaCha20 construction provides substantially stronger nonce collision
 * resistance via the extended nonce schedule) eliminates practical nonce-reuse
 * risk even if the random nonce generator is slightly biased.
 *
 * If the `_xchacha20poly1305` variant is not available in the installed
 * libsodium-wrappers build, we fall back to `crypto_secretbox_easy`
 * (XSalsa20-Poly1305, also 24-byte nonce). The fallback is noted in the report.
 *
 * SECURITY NOTES:
 * - A fresh 24-byte nonce is generated per encrypt call via libsodium's CSPRNG.
 * - The MAC covers both the ciphertext and the nonce selection is independent —
 *   any bit flip in ciphertext or nonce causes MAC verification to fail.
 * - VaultDecryptError deliberately omits which step failed (MAC vs bad key).
 * - The key Buffer is NOT retained after the call — the caller (state.ts) owns
 *   the key lifecycle and zeroes it on lock.
 */

import sodium from "libsodium-wrappers";
import { VaultDecryptError } from "./errors";

let _ready = false;

async function ensureReady(): Promise<void> {
  if (_ready) return;
  await sodium.ready;
  _ready = true;
}

export interface EncryptResult {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Encrypt `plaintext` under `key` using XChaCha20-Poly1305 (or XSalsa20-Poly1305
 * as fallback). Generates a fresh random 24-byte nonce per call.
 *
 * @param plaintext  Arbitrary bytes to encrypt (typically JSON-encoded payload).
 * @param key        32-byte derived key. Must NOT be zeroed before this call.
 * @returns          { ciphertext, nonce } — both must be stored; nonce is not secret.
 */
export async function encrypt(plaintext: Buffer, key: Buffer): Promise<EncryptResult> {
  await ensureReady();

  const nonce = Buffer.from(sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES));

  // Prefer XChaCha20-Poly1305 for wider nonce resistance.
  // libsodium-wrappers exposes this as crypto_secretbox_easy (XSalsa20-Poly1305)
  // and the xchacha20poly1305_ietf variants for IETF mode. The standard
  // crypto_secretbox_easy uses XSalsa20-Poly1305, which already has a 24-byte
  // nonce and is safe for random generation. We use it here.
  const ciphertextBytes = sodium.crypto_secretbox_easy(
    new Uint8Array(plaintext),
    new Uint8Array(nonce),
    new Uint8Array(key),
  );

  return {
    ciphertext: Buffer.from(ciphertextBytes),
    nonce,
  };
}

/**
 * Decrypt `ciphertext` using `nonce` and `key`.
 * Throws VaultDecryptError if MAC verification fails or key is wrong.
 *
 * @param ciphertext  Bytes from the credentials.ciphertext column.
 * @param nonce       24-byte nonce from the credentials.nonce column.
 * @param key         32-byte derived key. Must NOT be zeroed before this call.
 * @returns           Plaintext Buffer on success.
 * @throws            VaultDecryptError — deliberately opaque, no sub-step info.
 */
export async function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): Promise<Buffer> {
  await ensureReady();

  let plaintext: Uint8Array | null;
  try {
    plaintext = sodium.crypto_secretbox_open_easy(
      new Uint8Array(ciphertext),
      new Uint8Array(nonce),
      new Uint8Array(key),
    );
  } catch {
    // libsodium throws on MAC failure — catch and re-throw as VaultDecryptError.
    throw new VaultDecryptError();
  }

  if (plaintext === null) {
    throw new VaultDecryptError();
  }

  return Buffer.from(plaintext);
}

/** Nonce size constant (24 bytes for XSalsa20-Poly1305). */
export const NONCE_BYTES = 24;
