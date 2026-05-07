"use client";

import { PlusCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { WebappTile } from "@/components/webapp-tile";
import { useStatusPoll } from "@/hooks/use-status-poll";
import type { Webapp } from "@/lib/contracts";

interface LaunchpadGridProps {
  initialApps: Webapp[];
}

function SkeletonTile() {
  return (
    <div className="flex flex-col rounded-xl border border-border overflow-hidden">
      <div className="aspect-video w-full skeleton" />
      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        <div className="h-3.5 w-3/4 skeleton rounded" />
        <div className="h-3 w-1/2 skeleton rounded" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="col-span-full flex flex-col items-center justify-center py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-5">
        <PlusCircle className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold mb-1">No apps yet</h2>
      <p className="text-sm text-muted-foreground mb-5 max-w-xs">
        Register your first webapp to see it appear on the launchpad.
      </p>
      <Link
        href="/settings"
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusCircle className="h-4 w-4" />
        Register your first webapp
      </Link>
    </div>
  );
}

export function LaunchpadGrid({ initialApps }: LaunchpadGridProps) {
  const [apps, setApps] = useState<Webapp[]>(initialApps);
  const [vaultLocked, setVaultLocked] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);

  const appIds = apps.map((a) => a.id);
  const statusMap = useStatusPoll(appIds);

  // Refresh app list from server
  const refreshApps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/apps");
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Webapp[] };
      if (json.data) setApps(json.data);
    } catch {
      // Keep stale
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll vault status to know if vault is locked (affects badge colour)
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("/api/vault/status");
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { locked: boolean } };
        if (json.data !== undefined) {
          setVaultLocked(json.data.locked);
        }
      } catch {
        // ignore
      }
    };
    void check();
    const interval = setInterval(() => void check(), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Listen for settings-page mutations so grid can refresh
  useEffect(() => {
    const handler = () => void refreshApps();
    window.addEventListener("dashboard:apps-changed", handler);
    return () => window.removeEventListener("dashboard:apps-changed", handler);
  }, [refreshApps]);

  if (loading && apps.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(["s1", "s2", "s3"] as const).map((k) => (
          <SkeletonTile key={k} />
        ))}
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <div className="grid grid-cols-1">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {apps.map((webapp) => (
        <WebappTile
          key={webapp.id}
          webapp={webapp}
          status={statusMap[webapp.id] ?? null}
          vaultLocked={vaultLocked}
        />
      ))}
    </div>
  );
}
