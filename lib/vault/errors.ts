/**
 * lib/vault/errors.ts — typed error classes for the vault module.
 *
 * All errors are exported from lib/vault/index.ts. Import them from there,
 * not directly from this file.
 *
 * SECURITY NOTE: Error messages must NEVER include plaintext credential data,
 * derived key bytes, or any information that reveals which specific step of the
 * decrypt pipeline failed (to avoid oracle attacks).
 */

export class VaultLockedError extends Error {
  readonly code = "VAULT_LOCKED" as const;
  constructor() {
    super("Vault is locked. Unlock the vault before performing this operation.");
    this.name = "VaultLockedError";
  }
}

export class VaultDecryptError extends Error {
  readonly code = "VAULT_DECRYPT_FAILED" as const;
  constructor() {
    // Deliberately vague — do NOT leak which step (MAC, nonce, key) failed.
    super("Decrypt failed.");
    this.name = "VaultDecryptError";
  }
}

export class VaultAlreadyInitError extends Error {
  readonly code = "VAULT_ALREADY_INIT" as const;
  constructor() {
    super("Vault is already initialised. Use unlock to open an existing vault.");
    this.name = "VaultAlreadyInitError";
  }
}

export class VaultNotInitError extends Error {
  readonly code = "VAULT_NOT_INIT" as const;
  constructor() {
    super("Vault has not been initialised. Call POST /api/vault/unlock to initialise.");
    this.name = "VaultNotInitError";
  }
}
