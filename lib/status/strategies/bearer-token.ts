/**
 * lib/status/strategies/bearer-token.ts — Bearer token status check.
 *
 * Injects an Authorization: Bearer <token> header then delegates to the
 * shared HEAD→GET fetch helper from the none strategy.
 */

import type { StatusResult } from "@/lib/contracts";
import { fetchWithFallback } from "./none";

export interface AuthOpts {
  kind: "bearer";
  token: string;
}

export async function check(url: string, opts: AuthOpts): Promise<StatusResult> {
  return fetchWithFallback(url, {
    Authorization: `Bearer ${opts.token}`,
  });
}
