/**
 * lib/status/strategies/basic-auth.ts — HTTP Basic Auth status check.
 *
 * Injects an Authorization: Basic <base64(user:pass)> header then delegates
 * to the shared HEAD→GET fetch helper from the none strategy.
 */

import type { StatusResult } from "@/lib/contracts";
import { fetchWithFallback } from "./none";

export interface AuthOpts {
  kind: "basic";
  username: string;
  password: string;
}

export async function check(url: string, opts: AuthOpts): Promise<StatusResult> {
  const credentials = Buffer.from(`${opts.username}:${opts.password}`, "utf-8").toString("base64");
  return fetchWithFallback(url, {
    Authorization: `Basic ${credentials}`,
  });
}
