/**
 * lib/vault/state.ts — singleton in-process vault state.
 *
 * Holds the derived key in a Buffer (never a string — strings in V8 are
 * immutable and their memory cannot be zeroed), an unlock timestamp, and an
 * idle auto-lock timer.
 *
 * SECURITY INVARIANTS:
 * 1. The key is stored as a mutable Buffer so we can zero it before release.
 * 2. On lock() and on idle timeout, key bytes are zeroed with fill(0) before
 *    the reference is dropped. This mitigates cold-boot / heap-dump exposure.
 * 3. getKey() resets the idle timer on every access, so activity keeps the
 *    vault open. A genuine idle period causes auto-lock.
 * 4. The key NEVER leaves this module — callers receive a reference only
 *    within the sync portion of the vault operation. External callers must not
 *    store the Buffer reference.
 *
 * IDLE TIMEOUT:
 * Reads VAULT_IDLE_TIMEOUT_MS from process.env. Default: 1,800,000 ms (30 min).
 * Set to a smaller value in tests via vi.useFakeTimers + process.env override.
 */

import { VaultLockedError } from "./errors";

const DEFAULT_IDLE_MS = 30 * 60 * 1000; // 30 minutes

function getIdleTimeoutMs(): number {
  const envVal = process.env.VAULT_IDLE_TIMEOUT_MS;
  if (envVal !== undefined) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_MS;
}

interface VaultState {
  key: Buffer | null;
  unlockedAt: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const _state: VaultState = {
  key: null,
  unlockedAt: null,
  idleTimer: null,
};

function clearIdleTimer(): void {
  if (_state.idleTimer !== null) {
    clearTimeout(_state.idleTimer);
    _state.idleTimer = null;
  }
}

function armIdleTimer(): void {
  clearIdleTimer();
  _state.idleTimer = setTimeout(() => {
    zeroAndLock();
  }, getIdleTimeoutMs());
}

/** Zero the key buffer and reset all state. */
function zeroAndLock(): void {
  if (_state.key !== null) {
    _state.key.fill(0);
    _state.key = null;
  }
  _state.unlockedAt = null;
  clearIdleTimer();
}

/**
 * Store `key` as the active vault key and start the idle timer.
 *
 * The caller MUST NOT retain the original Buffer reference after this call;
 * the state module takes ownership and will zero it on lock.
 */
export function unlock(key: Buffer): void {
  // If already unlocked, zero the old key before replacing.
  if (_state.key !== null) {
    _state.key.fill(0);
  }
  _state.key = key;
  _state.unlockedAt = Date.now();
  armIdleTimer();
}

/**
 * Zero the key buffer and lock the vault.
 * Safe to call when already locked (no-op).
 */
export function lock(): void {
  zeroAndLock();
}

/** Returns true if the vault is currently unlocked. */
export function isUnlocked(): boolean {
  return _state.key !== null;
}

/**
 * Returns the active key Buffer. Resets the idle timer on every call.
 *
 * IMPORTANT: Callers must use the key synchronously and MUST NOT store the
 * reference. The buffer can be zeroed at any time by lock() or the idle timer.
 *
 * @throws VaultLockedError if vault is locked.
 */
export function getKey(): Buffer {
  if (_state.key === null) {
    throw new VaultLockedError();
  }
  // Reset idle timer on every access (activity keeps vault open).
  armIdleTimer();
  return _state.key;
}

/** Returns the timestamp when the vault was last unlocked, or null. */
export function getUnlockedAt(): number | null {
  return _state.unlockedAt;
}

/** Exposed for tests only — reads the current idle timeout from env. */
export function getIdleTimeoutMsExported(): number {
  return getIdleTimeoutMs();
}
