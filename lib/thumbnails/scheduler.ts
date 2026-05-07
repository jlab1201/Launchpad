/**
 * lib/thumbnails/scheduler.ts — background refresh loop.
 *
 * On first import, starts a setInterval that every 6h iterates all webapps
 * with autoScreenshot=1 and runs captureThumbnail sequentially.
 *
 * A string-keyed global guard prevents duplicate timers under Next.js hot-reload.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { webapps as webappsTable } from "@/lib/db/schema";
import { vaultStatus } from "@/lib/vault";
import { captureThumbnail } from "./runner";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Use a plain string key on globalThis — Symbol cannot be used in declare global.
const GUARD_KEY = "dashboard.thumbnailScheduler";

type GlobalWithGuard = typeof globalThis & {
  [k: string]: ReturnType<typeof setInterval> | undefined;
};

// ---------------------------------------------------------------------------
// Internal refresh runner
// ---------------------------------------------------------------------------

async function runScheduledRefresh(): Promise<void> {
  const db = getDb();

  let autoApps: { id: string; name: string }[];
  try {
    autoApps = await db.query.webapps.findMany({
      where: eq(webappsTable.autoScreenshot, 1),
      columns: { id: true, name: true },
    });
  } catch (err) {
    console.error(
      "[thumbnail-scheduler] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (autoApps.length === 0) return;

  for (const app of autoApps) {
    // Check vault before every app — user could lock mid-loop.
    const status = await vaultStatus();
    if (!status.unlocked) {
      // Vault is locked — skip without logging credential details.
      console.info(`[thumbnail-scheduler] skip app=${app.id} reason=vault_locked`);
      continue;
    }

    const result = await captureThumbnail(app.id);
    if ("error" in result) {
      console.error(`[thumbnail-scheduler] capture failed app=${app.id} error=${result.error}`);
    } else {
      console.info(`[thumbnail-scheduler] captured app=${app.id} capturedAt=${result.capturedAt}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start the scheduler (idempotent via global guard)
// ---------------------------------------------------------------------------

function startScheduler(): void {
  const g = globalThis as GlobalWithGuard;

  if (g[GUARD_KEY] !== undefined) {
    // Already running (hot-reload guard).
    return;
  }

  // Run every 6h.
  const timer = setInterval(() => {
    runScheduledRefresh().catch((err) => {
      console.error(
        "[thumbnail-scheduler] unexpected error:",
        err instanceof Error ? err.message : err,
      );
    });
  }, INTERVAL_MS);

  // Allow the process to exit without waiting for the timer.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  g[GUARD_KEY] = timer;
}

// Start on import.
startScheduler();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trigger an immediate one-off capture for a single webapp.
 * Called by the POST /api/thumbnail/refresh route.
 */
export async function triggerRefresh(webappId: string) {
  return captureThumbnail(webappId);
}
