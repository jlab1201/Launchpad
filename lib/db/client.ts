import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Returns a singleton Drizzle database instance backed by better-sqlite3.
 *
 * The database file path is read from DATABASE_PATH env var, defaulting to
 * ./data/db.sqlite relative to the project root. WAL mode is enabled for
 * better concurrent read performance.
 *
 * This is safe to call on every request — the singleton ensures only one
 * Database connection is opened per process.
 */
export function getDb() {
  if (_db) return _db;

  const dbPath = process.env.DATABASE_PATH ?? "./data/db.sqlite";
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance and crash safety.
  sqlite.pragma("journal_mode = WAL");
  // Enforce foreign key constraints (SQLite disables them by default).
  sqlite.pragma("foreign_keys = ON");

  _db = drizzle(sqlite, { schema });
  return _db;
}
