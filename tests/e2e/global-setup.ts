/**
 * tests/e2e/global-setup.ts
 *
 * Runs once before the entire Playwright suite.
 *
 * 1. Wipes the e2e test database (or creates it fresh).
 * 2. Applies Drizzle migrations so the schema is current.
 * 3. Installs the Chromium browser binary if it is not already present.
 *    Re-running is idempotent — if the binary already exists, the install
 *    command exits immediately with no download.
 *
 * PRECONDITION (first run): Chromium will be downloaded (~200 MB). This
 * takes approximately 2 minutes on a typical broadband connection.
 * Subsequent runs reuse the cached binary and add no overhead.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const E2E_DB_PATH = path.join(DATA_DIR, "e2e-test.sqlite");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runSync(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")} (exit ${result.status ?? "null"})`);
  }
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function resetDatabase() {
  // Ensure the data directory exists.
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Wipe any leftover e2e database from a previous run.
  for (const ext of ["", "-wal", "-shm"]) {
    const p = E2E_DB_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log("[global-setup] Running migrations against e2e database...");
  runSync("pnpm", ["db:migrate"], { env: { ...process.env, DATABASE_PATH: E2E_DB_PATH } });
  console.log("[global-setup] Migrations complete.");
}

// ---------------------------------------------------------------------------
// Chromium install (idempotent)
// ---------------------------------------------------------------------------

function ensureChromium() {
  // Use Playwright's own registry to check whether the binary exists.
  // `playwright install --dry-run chromium` exits 0 and prints nothing when
  // all browsers are already present; exits non-zero when a download is needed.
  const dryRun = spawnSync("pnpm", ["exec", "playwright", "install", "--dry-run", "chromium"], {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    env: { ...process.env },
  });

  const needsInstall =
    dryRun.status !== 0 ||
    (dryRun.stdout ?? "").toLowerCase().includes("chromium") ||
    (dryRun.stderr ?? "").toLowerCase().includes("chromium");

  if (needsInstall) {
    console.log("[global-setup] Chromium not found — installing (first run only, ~2 min)...");
    runSync("pnpm", ["exec", "playwright", "install", "chromium"]);
    console.log("[global-setup] Chromium installed.");
  } else {
    console.log("[global-setup] Chromium already installed, skipping.");
  }
}

// ---------------------------------------------------------------------------
// Export: Playwright global setup hook
// ---------------------------------------------------------------------------

export default async function globalSetup() {
  resetDatabase();
  ensureChromium();

  // Tell the web-server process to use the e2e database.
  // Playwright merges this into the webServer process env.
  process.env.DATABASE_PATH = E2E_DB_PATH;
}
