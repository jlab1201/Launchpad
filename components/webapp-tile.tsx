"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { StatusResult, Webapp } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface WebappTileProps {
  webapp: Webapp;
  status: StatusResult | null;
  vaultLocked?: boolean;
}

/** Generates a deterministic background colour from a string */
function seedColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function StatusDot({
  status,
  vaultLocked,
}: {
  status: StatusResult | null;
  vaultLocked?: boolean;
}) {
  if (vaultLocked) {
    return (
      <span
        role="img"
        title="Vault locked"
        className="block h-2.5 w-2.5 rounded-full bg-yellow-400 ring-2 ring-background"
        aria-label="Status: vault locked"
      />
    );
  }

  if (!status) {
    return (
      <span
        role="img"
        title="Checking…"
        className="block h-2.5 w-2.5 rounded-full bg-yellow-400 ring-2 ring-background animate-pulse"
        aria-label="Status: checking"
      />
    );
  }

  if (status.ok) {
    return (
      <span
        role="img"
        title={`Up — ${status.latencyMs !== null ? `${status.latencyMs}ms` : "ok"}`}
        className="block h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-background"
        aria-label="Status: up"
      />
    );
  }

  return (
    <span
      role="img"
      title={status.error ?? "Down"}
      className="block h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background"
      aria-label="Status: down"
    />
  );
}

export function WebappTile({ webapp, status, vaultLocked }: WebappTileProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgKey, setImgKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const accentColor = seedColor(webapp.name);
  const initial = webapp.name.charAt(0).toUpperCase();

  const handleRefreshThumbnail = useCallback(
    async (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (refreshing) return;
      setRefreshing(true);
      try {
        const res = await fetch(`/api/thumbnail/refresh?id=${webapp.id}`, {
          method: "POST",
        });
        if (!res.ok && res.status !== 501) {
          toast.error("Could not refresh thumbnail");
        } else {
          // Bust the cache on the img element
          setImgKey((k) => k + 1);
          setImgFailed(false);
          toast.success("Thumbnail refreshed");
        }
      } catch {
        toast.error("Could not refresh thumbnail");
      } finally {
        setRefreshing(false);
      }
    },
    [webapp.id, refreshing],
  );

  return (
    <a
      href={webapp.url}
      target="_blank"
      rel="noopener noreferrer"
      className="tile-hover group relative flex flex-col rounded-xl border border-border bg-card text-card-foreground overflow-hidden cursor-pointer transition-shadow no-underline"
      aria-label={`Open ${webapp.name} in a new tab`}
    >
      {/* Thumbnail area */}
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {!imgFailed ? (
          // biome-ignore lint/performance/noImgElement: thumbnail served from same-origin API route, next/image optimization not applicable
          <img
            key={imgKey}
            src={`/api/thumbnail/${webapp.id}?v=${imgKey}`}
            alt={`Screenshot of ${webapp.name}`}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          // Fallback placeholder
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ background: accentColor }}
          >
            <span className="text-5xl font-bold text-white/80 select-none">{initial}</span>
          </div>
        )}

        {/* Status dot overlay */}
        <div className="absolute top-2 right-2">
          <StatusDot status={status} vaultLocked={vaultLocked} />
        </div>

        {/* Refresh button overlay */}
        <button
          type="button"
          className={cn(
            "absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md",
            "bg-background/70 text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            "backdrop-blur-sm transition-opacity hover:bg-background/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-label={`Refresh thumbnail for ${webapp.name}`}
          onClick={(e) => void handleRefreshThumbnail(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") void handleRefreshThumbnail(e);
          }}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </button>
      </div>

      {/* Info row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-medium leading-tight">{webapp.name}</p>
          <p className="truncate text-xs text-muted-foreground leading-tight mt-0.5">
            {webapp.url}
          </p>
        </div>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </a>
  );
}
