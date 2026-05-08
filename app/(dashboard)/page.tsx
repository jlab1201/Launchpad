/**
 * Launchpad — server component.
 * Reads apps directly from the DB for the initial render, then hands off
 * to the client <LaunchpadGrid> for polling and interactions.
 *
 * Direct DB read removes the host-header self-fetch (Finding 8 — host-header
 * injection surface) and eliminates an unnecessary network hop.
 */
import { asc } from "drizzle-orm";
import { LaunchpadGrid } from "@/components/launchpad-grid";
import type { Webapp } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { webapps } from "@/lib/db/schema";

async function fetchApps(): Promise<Webapp[]> {
  try {
    const db = getDb();
    const rows = await db.select().from(webapps).orderBy(asc(webapps.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      authType: row.authType as Webapp["authType"],
      autoScreenshot: row.autoScreenshot === 1,
      thumbnailUrl: row.thumbnailUrl ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  } catch {
    return [];
  }
}

export default async function LaunchpadPage() {
  const apps = await fetchApps();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      <LaunchpadGrid initialApps={apps} />
    </div>
  );
}
