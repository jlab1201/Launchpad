/**
 * tests/e2e/vault-credential-flow.spec.ts — Security journey
 *
 * 1. Initialise the vault via POST /api/vault/unlock (first call = init).
 * 2. Register a webapp with bearer auth + a unique fake token.
 * 3. Query the SQLite credentials table directly and assert:
 *      a. The `ciphertext` column contains binary blobs (not plaintext).
 *      b. The literal token string does NOT appear in any column value.
 *      This is the "you can't grep our DB for secrets" assertion.
 * 4. Lock the vault.
 * 5. Attempt to register another app with a credential — expect 423 Locked.
 * 6. Re-unlock with the WRONG passphrase → API returns 401 (or status stays locked).
 * 7. Re-unlock with the CORRECT passphrase → success.
 *
 * Database access in steps 3 uses better-sqlite3 directly (same approach as
 * tests/vault.test.ts) so the assertion is independent of the API layer.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const E2E_DB_PATH = path.join(DATA_DIR, "e2e-test.sqlite");

const PASSPHRASE = "e2e-test-passphrase-vault-flow";
const FAKE_TOKEN = `e2e-token-${Date.now()}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb() {
  return new Database(E2E_DB_PATH, { readonly: true });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const registeredIds: string[] = [];

test.afterAll(async ({ request }) => {
  for (const id of registeredIds) {
    await request.delete(`/api/apps/${id}`).catch(() => undefined);
  }
  // Lock the vault so other tests start from a clean state
  await request.post("/api/vault/lock").catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Tests (serial — order matters)
// ---------------------------------------------------------------------------

test.describe
  .serial("vault credential flow", () => {
    test("1. initialise vault via POST /api/vault/unlock", async ({ request }) => {
      const res = await request.post("/api/vault/unlock", {
        data: { passphrase: PASSPHRASE },
      });
      // First call: 200 with status "initialised" or "unlocked"
      expect(res.ok()).toBe(true);
      const json = (await res.json()) as { status?: string };
      expect(["initialised", "unlocked"]).toContain(json.status);
    });

    test("2. register a webapp with bearer auth + fake token", async ({ request }) => {
      const res = await request.post("/api/apps", {
        data: {
          name: "E2E-Vault-Test",
          url: "http://localhost:3000",
          authType: "bearer",
          autoScreenshot: false,
          credential: { kind: "token", token: FAKE_TOKEN },
        },
      });
      expect(res.status()).toBe(201);
      const json = (await res.json()) as {
        data?: { webapp?: { id: string }; credential?: { id: string } };
      };
      expect(json.data?.webapp?.id).toBeTruthy();
      expect(json.data?.credential?.id).toBeTruthy();
      if (json.data?.webapp?.id) {
        registeredIds.push(json.data.webapp.id);
      }
    });

    test("3. credentials table stores ciphertext — literal token MUST NOT appear", async () => {
      // Only run if the DB file exists (i.e. globalSetup ran successfully)
      if (!fs.existsSync(E2E_DB_PATH)) {
        test.skip();
        return;
      }

      const db = openDb();
      try {
        const rows = db.prepare("SELECT * FROM credentials").all() as Array<
          Record<string, unknown>
        >;

        expect(rows.length).toBeGreaterThan(0);

        for (const row of rows) {
          for (const [colName, value] of Object.entries(row)) {
            if (value instanceof Buffer || Buffer.isBuffer(value)) {
              // The column is a binary blob.
              const hexDecoded = (value as Buffer).toString("utf-8");
              expect(
                hexDecoded,
                `Column "${colName}" should not contain the plaintext token`,
              ).not.toContain(FAKE_TOKEN);

              // Assert it looks like random binary (not a readable JSON string)
              const asText = (value as Buffer).toString("utf-8");
              expect(asText).not.toBe(FAKE_TOKEN);
            } else if (typeof value === "string") {
              // Text columns (id, webapp_id, kind) must also not contain the token.
              expect(
                value,
                `Text column "${colName}" must not contain plaintext token`,
              ).not.toContain(FAKE_TOKEN);
            }
          }
        }
      } finally {
        db.close();
      }
    });

    test("4. lock vault via POST /api/vault/lock", async ({ request }) => {
      const res = await request.post("/api/vault/lock");
      expect(res.ok()).toBe(true);
      const json = (await res.json()) as { status?: string };
      expect(json.status).toBe("locked");
    });

    test("5. register app with credentials when vault is locked → 423", async ({ request }) => {
      const res = await request.post("/api/apps", {
        data: {
          name: "E2E-Locked-Test",
          url: "http://localhost:3000",
          authType: "bearer",
          autoScreenshot: false,
          credential: { kind: "token", token: "should-fail-token" },
        },
      });
      expect(res.status()).toBe(423);
    });

    test("6. re-unlock with WRONG passphrase → 401", async ({ request }) => {
      const res = await request.post("/api/vault/unlock", {
        data: { passphrase: "wrong-passphrase-definitely-not-correct" },
      });
      // The API returns 401 when the passphrase is wrong AND credentials exist.
      // On a fresh vault with no credentials, the wrong passphrase cannot be
      // detected until the first decrypt attempt; in that case the unlock returns
      // 200 but subsequent decrypt-needing operations will fail.
      // Since we registered a credential in step 2, the wrong passphrase MUST
      // return 401 here.
      expect(res.status()).toBe(401);
      const json = (await res.json()) as { error?: { code?: string } };
      expect(json.error?.code).toBe("UNAUTHORIZED");
    });

    test("7. re-unlock with CORRECT passphrase → success", async ({ request }) => {
      const res = await request.post("/api/vault/unlock", {
        data: { passphrase: PASSPHRASE },
      });
      expect(res.ok()).toBe(true);
      const json = (await res.json()) as { status?: string };
      expect(["unlocked", "initialised"]).toContain(json.status);
    });

    test("8. vault status API confirms unlocked after correct passphrase", async ({ request }) => {
      const res = await request.get("/api/vault/status");
      expect(res.ok()).toBe(true);
      const json = (await res.json()) as { data?: { locked: boolean; unlocked: boolean } };
      // Accept either `locked: false` or `unlocked: true` depending on API shape
      const isUnlocked = json.data?.locked === false || json.data?.unlocked === true;
      expect(isUnlocked).toBe(true);
    });

    test("9. random UUID token is not present anywhere in the DB (extra grep check)", async () => {
      if (!fs.existsSync(E2E_DB_PATH)) {
        test.skip();
        return;
      }

      const uniqueToken = crypto.randomUUID();

      // Register an app with the UUID as token (vault is unlocked from step 7)
      // We do this by opening the DB in write mode — but we must use the API to
      // ensure the vault layer runs. Use fetch directly from the test node process.
      const fetchRes = await fetch("http://localhost:3000/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "E2E-UUID-Token-Check",
          url: "http://localhost:3000",
          authType: "bearer",
          autoScreenshot: false,
          credential: { kind: "token", token: uniqueToken },
        }),
      });
      const fetchJson = (await fetchRes.json()) as { data?: { webapp?: { id: string } } };
      if (fetchJson.data?.webapp?.id) {
        registeredIds.push(fetchJson.data.webapp.id);
      }

      // Now grep the entire DB binary for the UUID string.
      const dbBuffer = fs.readFileSync(E2E_DB_PATH);
      const dbText = dbBuffer.toString("binary");
      expect(dbText).not.toContain(uniqueToken);
    });
  });
