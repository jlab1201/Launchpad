"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResult } from "@/lib/contracts";

type StatusMap = Record<string, StatusResult | null>;

const POLL_INTERVAL_MS = 60_000;

/**
 * Polls /api/status (bulk) every 60s.
 * Returns a stale-while-revalidate map of appId → StatusResult | null.
 * null means pending/unknown; on 501, gracefully returns empty map.
 */
export function useStatusPoll(appIds: string[]) {
  const [statusMap, setStatusMap] = useState<StatusMap>({});
  const isMounted = useRef(true);

  const fetchStatuses = useCallback(async () => {
    if (appIds.length === 0) return;
    try {
      const res = await fetch("/api/status");
      if (res.status === 501) {
        // Phase 3 not yet implemented
        return;
      }
      if (!res.ok) return;
      const json = (await res.json()) as { data?: Record<string, StatusResult> };
      if (json.data && isMounted.current) {
        setStatusMap(json.data);
      }
    } catch {
      // Keep stale data
    }
  }, [appIds]);

  useEffect(() => {
    isMounted.current = true;
    void fetchStatuses();
    const interval = setInterval(() => void fetchStatuses(), POLL_INTERVAL_MS);
    return () => {
      isMounted.current = false;
      clearInterval(interval);
    };
  }, [fetchStatuses]);

  return statusMap;
}
