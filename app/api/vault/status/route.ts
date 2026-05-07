/**
 * GET /api/vault/status
 *
 * Returns current vault status. No auth required — status itself carries no
 * sensitive information. Vault state does NOT survive a process restart.
 *
 * Response: { initialised: boolean, unlocked: boolean, idleTimeoutMs: number }
 */
import { NextResponse } from "next/server";
import { vaultStatus } from "@/lib/vault";

export async function GET() {
  const status = await vaultStatus();
  return NextResponse.json(status);
}
