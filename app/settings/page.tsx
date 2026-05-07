/**
 * Settings / Registration UI — Phase 5.
 * Server component: fetches initial app list, renders SettingsPanel client component.
 */
import { headers } from "next/headers";
import { SettingsPanel } from "@/components/settings-panel";
import type { Webapp } from "@/lib/contracts";

async function fetchApps(): Promise<Webapp[]> {
  try {
    const hdrs = await headers();
    const host = hdrs.get("host") ?? "localhost:15123";
    const proto = process.env.NODE_ENV === "production" ? "https" : "http";
    const res = await fetch(`${proto}://${host}/api/apps`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Webapp[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

export default async function SettingsPage() {
  const apps = await fetchApps();

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8">
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
