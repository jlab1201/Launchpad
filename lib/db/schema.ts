import { sql } from "drizzle-orm";
import { blob, int, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// webapps — registered applications in the launchpad
// ---------------------------------------------------------------------------
export const webapps = sqliteTable("webapps", {
  id: text("id").primaryKey(), // UUID generated in application layer
  name: text("name").notNull(),
  url: text("url").notNull(),
  /** How the status-check and thumbnail-capture authenticate against this app. */
  authType: text("auth_type", { enum: ["none", "basic", "bearer"] })
    .notNull()
    .default("none"),
  /** 1 = capture screenshot automatically; 0 = manual only. */
  autoScreenshot: int("auto_screenshot").notNull().default(1),
  /**
   * Optional URL the screenshot service should capture instead of `url`.
   * Lets the user pin the thumbnail to a specific deep page (e.g. a Grafana
   * dashboard view) while still launching the app at its main URL.
   * Null/empty means "use `url`".
   */
  thumbnailUrl: text("thumbnail_url"),
  createdAt: int("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
  updatedAt: int("updated_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ---------------------------------------------------------------------------
// credentials — encrypted credential records
//
// SECURITY CONTRACT:
//   - The `ciphertext` column stores ONLY the output of libsodium secretbox.
//   - The `nonce` column stores the per-record random nonce for that secretbox.
//   - There is NO plaintext column in this table by design.
//   - Storing plaintext in either column is a critical security defect.
//   - All read/write to this table MUST go through lib/vault/ — never raw SQL
//     that constructs or inspects credential content outside that module.
//
// AUDIT NOTE (for security-engineer review):
//   Any PR that adds a new column to this table, or that reads `ciphertext`
//   outside of lib/vault/, requires explicit security-engineer sign-off.
// ---------------------------------------------------------------------------
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(), // UUID generated in application layer
  webappId: text("webapp_id")
    .notNull()
    .references(() => webapps.id, { onDelete: "cascade" }),
  /**
   * ENCRYPTED ONLY — libsodium secretbox ciphertext (XChaCha20-Poly1305).
   * NEVER store plaintext here. See lib/vault/ for encrypt/decrypt helpers.
   */
  ciphertext: blob("ciphertext").notNull(),
  /**
   * Per-record random nonce (24 bytes for XChaCha20-Poly1305).
   * Generated fresh for every encrypt call. NOT secret, but must be stored.
   */
  nonce: blob("nonce").notNull(),
  /**
   * Credential kind. Only `password` and `token` are wired up in v1.
   * `cookie` and `note` are accepted by the schema for forward compatibility
   * but have no implementation yet — Phase 2 will add handlers as needed.
   */
  kind: text("kind", { enum: ["password", "token", "cookie", "note"] })
    .notNull()
    .default("password"),
  createdAt: int("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ---------------------------------------------------------------------------
// vault_meta — one row per installation (singleton pattern)
//
// Stores the KDF salt and Argon2id parameters used to derive the vault key
// from the master passphrase. Lives in SQLite (not in a separate JSON file)
// so that the backup story is: copy the SQLite file → you have everything
// except the passphrase.
// ---------------------------------------------------------------------------
export const vaultMeta = sqliteTable("vault_meta", {
  /** Always the string literal 'singleton'. Enforced at the application layer. */
  id: text("id")
    .primaryKey()
    .$default(() => "singleton"),
  /**
   * Random 16-byte salt generated once at vault initialisation.
   * Must never be reused across different passphrases.
   */
  kdfSalt: blob("kdf_salt"),
  /**
   * JSON-encoded Argon2id cost parameters: { m: number, t: number, p: number }
   * where m = memory (KiB), t = iterations, p = parallelism.
   * Stored as text so the values are human-readable in a sqlite3 dump.
   */
  kdfParams: text("kdf_params"), // JSON: { m, t, p }
  createdAt: int("created_at").notNull().default(sql`(unixepoch('now') * 1000)`),
});

// ---------------------------------------------------------------------------
// Exported types (inferred from Drizzle schema — single source of truth)
// ---------------------------------------------------------------------------
export type Webapp = typeof webapps.$inferSelect;
export type NewWebapp = typeof webapps.$inferInsert;

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

export type VaultMeta = typeof vaultMeta.$inferSelect;
export type NewVaultMeta = typeof vaultMeta.$inferInsert;
