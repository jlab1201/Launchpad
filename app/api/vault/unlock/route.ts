/**
 * POST /api/vault/unlock
 *
 * Body: { passphrase: string }
 *
 * Behaviour:
 * - If vault is uninitialised (no kdfSalt row): generates salt, stores params,
 *   derives key, marks unlocked. Returns { status: "initialised" }.
 * - If vault is initialised: derives key with stored params, verifies against
 *   first credential row if any exist. Returns { status: "unlocked" }.
 *
 * SECURITY NOTES:
 * - Passphrase is consumed by the vault layer and never logged.
 * - Wrong passphrase returns 401 with a generic message.
 * - Rate limiting: 5 consecutive failures per IP trigger exponential lockout
 *   (1 min → 2 min → … → 30 min cap). See lib/security/rate-limit.ts.
 * - Origin check: cross-origin browser requests are rejected with 403.
 */
import { type NextRequest, NextResponse } from "next/server";
import { VaultUnlockInputSchema } from "@/lib/contracts";
import { assertSameOrigin } from "@/lib/security/origin";
import { checkRateLimit, recordFailure, recordSuccess } from "@/lib/security/rate-limit";
import { unlockVault, VaultDecryptError } from "@/lib/vault";

function getIpKey(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

export async function POST(req: NextRequest) {
  const deny = assertSameOrigin(req);
  if (deny) return deny;

  const ipKey = getIpKey(req);
  const rateCheck = checkRateLimit(ipKey);
  if (!rateCheck.allowed) {
    const retryAfterSec = Math.ceil(rateCheck.retryAfterMs / 1000);
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: `Too many attempts. Try again in ${retryAfterSec} seconds.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSec) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  const parsed = VaultUnlockInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          details: parsed.error.flatten().fieldErrors,
        },
      },
      { status: 422 },
    );
  }

  try {
    const result = await unlockVault(parsed.data.passphrase);
    recordSuccess(ipKey);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VaultDecryptError) {
      recordFailure(ipKey);
      // Generic 401 — do not reveal which step failed.
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Wrong passphrase." } },
        { status: 401 },
      );
    }
    throw err;
  }
}
