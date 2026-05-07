/**
 * POST /api/vault/lock
 *
 * Zeros the in-process key buffer and marks the vault locked.
 * Safe to call when already locked (idempotent).
 *
 * Response: { status: "locked" }
 *
 * SECURITY NOTE:
 * - Origin check: cross-origin browser requests are rejected with 403,
 *   preventing a co-resident page from silently locking the vault.
 */
import { type NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/security/origin";
import { lockVault } from "@/lib/vault";

export async function POST(req: NextRequest) {
  const deny = assertSameOrigin(req);
  if (deny) return deny;

  const result = lockVault();
  return NextResponse.json(result);
}
