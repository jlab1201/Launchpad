/**
 * GET /api/vault/status
 *
 * Returns current vault status. No auth required — status itself carries no
 * sensitive information. Vault state does NOT survive a process restart.
 *
 * Response: { data: { locked: boolean, initialised: boolean, idleTimeoutMs: number } }
 *
 * Wrapped in the standard `{ data: ... }` envelope used across the API and
 * documented in lib/contracts.ts (ApiSuccessSchema). The boolean is exposed as
 * `locked` (rather than the internal `unlocked`) because every client reader
 * naturally branches on "is the vault locked?" — keeping the field name aligned
 * with how it's used avoids the inversion bug that broke this endpoint before.
 */
import { NextResponse } from "next/server";
import { vaultStatus } from "@/lib/vault";

export async function GET() {
  const status = await vaultStatus();
  return NextResponse.json({
    data: {
      locked: !status.unlocked,
      initialised: status.initialised,
      idleTimeoutMs: status.idleTimeoutMs,
    },
  });
}
