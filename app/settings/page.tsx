/**
 * Settings / Registration UI — Phase 5.
 * Server component: reads the app list directly from the DB and renders the
 * SettingsPanel client component. Direct DB read mirrors app/(dashboard)/page.tsx
 * — avoids the host-header self-fetch surface and the http/https protocol
 * mismatch that returned [] in production self-hosted deployments.
 */
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SettingsPanel } from "@/components/settings-panel";
import type { Webapp } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { webapps } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

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

export default async function SettingsPage() {
  const apps = await fetchApps();

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your registered webapps and credentials.
        </p>
      </div>
      <SettingsPanel initialApps={apps} />
    </div>
  );
}
