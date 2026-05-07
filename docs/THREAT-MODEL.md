# Threat Model — Launchpad Credential Vault (v1)

## Overview

Launchpad stores credentials (usernames+passwords, API tokens) for registered internal webapps. Credentials are encrypted at rest using a passphrase-derived key that lives only in process memory for the duration of a session.

---

## Asset List

| Asset | Where it lives | Sensitivity |
|---|---|---|
| **Master passphrase** | User's memory only. Never written anywhere. | Highest — all other protections derive from this. |
| **Derived key (32 bytes)** | Node.js process heap (`Buffer`) while vault is unlocked. Zeroed on lock/idle timeout. | Highest — direct decryption key. |
| **Ciphertext blobs** | `credentials.ciphertext` column in `data/db.sqlite` | High — encrypted, but backup/theft makes offline attacks possible. |
| **KDF salt + params** | `vault_meta` row in `data/db.sqlite` | Medium — not secret, but required to mount a passphrase attack; should stay with the DB. |
| **Nonces** | `credentials.nonce` column | Low — not secret by design; unique per record. |
| **Plaintext credentials** | In-memory only, for the microseconds between decrypt and use. Never logged or persisted. | Highest — direct secret material. |

---

## Threats Considered

### 1. Stolen disk or backup (`data/db.sqlite`)

An attacker who obtains a copy of the database file gets ciphertext + nonce + kdf salt.

**Mitigations:**
- All credentials are encrypted with XSalsa20-Poly1305 via `libsodium crypto_secretbox_easy`. The MAC protects both integrity and confidentiality.
- The KDF is Argon2id with `memoryCost: 65536` (64 MiB), `timeCost: 3`, `parallelism: 4`. At these parameters, brute-forcing even a 6-word passphrase exceeds practical cost on consumer hardware.
- No plaintext column exists in the schema by design. The schema comment and a PR policy enforce this.
- A per-install random 16-byte salt prevents precomputed dictionary attacks.

**Residual risk:** A weak passphrase (e.g. dictionary word) under a stolen-disk attack is breakable. No strength enforcement is imposed in v1 — this is documented as a known residual risk below.

---

### 2. RAM dump on a running, unlocked instance

An attacker with code execution on the host reads the process heap while the vault is unlocked.

**Mitigations:**
- The derived key is stored as a mutable `Buffer` (not a string). V8 strings are immutable; `Buffer` memory can be explicitly zeroed.
- `state.lock()` and the idle-timeout callback call `key.fill(0)` before releasing the reference.
- The idle timeout defaults to 30 minutes and resets on every `getKey()` call.

**Residual risk:** Between unlock and zero there is a window where the key is in heap. In a language with GC (JavaScript), there is no guarantee that zeroed bytes are not copied by the allocator before `fill(0)` runs. This is a standard limitation of in-process secrets management in high-level languages and is accepted in v1.

---

### 3. Malicious browser extension

A malicious extension running in the same browser as the Launchpad UI could intercept network requests to `/api/vault/unlock` and capture the passphrase, or read DOM state.

**Mitigations:**
- The passphrase is only sent once (or on manual re-unlock) — short exposure window.
- No credential plaintext is ever returned in any API response. The API surface is designed so that even a full network intercept of all responses yields no credential material.
- HTTPS should be enforced in production (HSTS header recommended in `next.config` for prod deployments).

**Residual risk:** An extension with broad `webRequest` permissions can intercept the unlock POST before TLS, or read the unlock form field in the DOM. This is a browser-model attack and is considered out of scope for v1's single-user, local-machine deployment model. A future mitigation would be a locked-down CSP that disallows inline scripts and extension injection.

---

### 4. Phishing of the unlock dialog

A malicious page spoofs the Launchpad unlock dialog and captures the passphrase.

**Mitigations:**
- The dashboard runs on `localhost`. A phishing page cannot spoof a `localhost` origin in a browser — same-origin policy blocks cross-origin reads.
- The passphrase is only entered on Launchpad's own domain.

**Residual risk:** If the user installs Launchpad on a public IP or behind a tunnel without authentication, the unlock endpoint is reachable from the internet. Production deployments should sit behind at minimum an IP whitelist or an SSH tunnel. This is called out in the README.

---

### 5. Side-channel timing on decrypt

An attacker who can repeatedly query the API and measure response time might infer whether decryption succeeded (timing oracle).

**Mitigations:**
- `VaultDecryptError` is thrown at the first point of failure and is deliberately vague (does not leak which sub-step failed: MAC, nonce, or key).
- libsodium's `crypto_secretbox_open_easy` uses constant-time MAC comparison internally — the primitive itself does not leak timing information about the key.
- The Argon2id KDF dominates the response time for `/api/vault/unlock` (~200 ms–1 s depending on hardware), which drowns any per-record decrypt latency variation.

**Residual risk:** An attacker with sub-millisecond network access and many attempts could in theory detect the Argon2 completion boundary. Rate limiting (not present in v1) would close this.

---

### 6. Weak passphrase

The vault accepts any non-empty passphrase. A user who sets "password" or "1234" can have their vault brute-forced from a stolen database.

**Mitigations:**
- Argon2id parameters are intentionally expensive to slow brute-force. A single guess costs ~200 ms on commodity hardware.
- No further enforcement in v1.

**Residual risk:** No minimum entropy requirement. This is the primary residual risk for the at-rest threat. Documented in the setup guide as a user responsibility.

---

### 7. Missing rate-limit on `/api/vault/unlock`

The unlock endpoint performs Argon2id derivation on every request. Without rate limiting, an attacker with network access can submit many guesses, though each guess costs ~200 ms.

**Mitigations:**
- Argon2id's cost parameters make each guess expensive.
- The endpoint is intended to run on `localhost` only. Exposing it to the internet without a reverse proxy is a deployment misconfiguration, documented in the README.

**Residual risk:** No IP-based rate limiting in v1. The route comment documents where to add it.

---

### 8. Log or error leakage of plaintext credentials

A logging statement or a verbose error response could leak plaintext credential material.

**Mitigations:**
- No `console.log` statements in any vault module.
- `VaultDecryptError` message is a single opaque string: "Decrypt failed." — no key bytes, no sub-step information.
- The API layer catches vault errors and maps them to `{ error: { code, message } }` with no stack trace in the response.
- Plaintext payloads exist only in a local `Buffer` variable within the encrypt/decrypt call frame. They are not assigned to module-level variables and are not passed to any logger.

---

## Threats Out of Scope (v1)

| Threat | Why out of scope |
|---|---|
| Root on the running machine | Process memory is trivially readable by root. Defence requires an HSM or OS-level secret store. Out of scope by design for v1 (single-user, trusted-host model). |
| Hardware key extraction (cold-boot, DMA attack) | Requires physical access or specialised hardware. Out of scope. |
| OS keychain attacks | v1 does not integrate with OS keychain (`libsecret`, macOS Keychain). Keeps the security story simple for the public release. |
| Supply-chain attack on libsodium or @node-rs/argon2 | Mitigated by lockfile and `pnpm audit` in CI. Not enumerated separately. |

---

## Mitigations Summary Table

| Threat | Code/Config that addresses it |
|---|---|
| Stolen disk | Argon2id KDF in `lib/vault/kdf.ts`, secretbox MAC in `lib/vault/cipher.ts` |
| RAM dump | `key.fill(0)` in `state.lock()` and idle timer callback in `lib/vault/state.ts` |
| Malicious extension | No credential in any API response; `lib/contracts.ts` response schemas exclude credential fields |
| Phishing | `localhost` deployment model; no credential in response |
| Timing oracle | libsodium constant-time MAC; opaque `VaultDecryptError`; Argon2 dominates timing |
| Weak passphrase | Argon2id cost params (m=65536, t=3, p=4); documented risk |
| No rate-limit | Argon2 cost; `localhost` default; route comment documents where to add rate limiting |
| Log leakage | No logging of plaintext; opaque errors; local-only Buffer lifetime |

---

## Known Residual Risks (v1)

1. **Weak passphrase** — no enforcement. User responsibility, documented.
2. **No rate-limiting on `/api/vault/unlock`** — Argon2 cost is the only brake. Acceptable for localhost; must be addressed before public-internet exposure.
3. **Key in heap window** — Between `state.unlock()` and `key.fill(0)`, a heap dump captures the key. Standard JS limitation; no practical mitigation without WASM sandbox or native key stores.
4. **No HTTPS enforcement in dev mode** — Development runs on plain HTTP. Production deployments should run behind a TLS-terminating proxy with HSTS.
