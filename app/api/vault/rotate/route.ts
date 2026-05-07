/**
 * POST /api/vault/rotate
 *
 * Body: { oldPassphrase: string, newPassphrase: string }
 *
 * Decrypts all credential rows under the old key, re-encrypts under the new
 * key with fresh nonces, swaps vault_meta to the new salt/params, and updates
 * the in-process key — all within a single SQLite transaction.
 *
 * If any row fails to re-encrypt (wrong old passphrase, tampered data), the
 * entire operation is rolled back.
 *
 * Response: { status: "rotated", recordsReencrypted: number }
 *
 * SECURITY NOTES:
 * - Both passphrases are consumed by the vault layer and never logged.
 * - Wrong oldPassphrase returns 401 with a generic message.
 * - After a successful rotation, the old passphrase can no longer unlock the vault.
 * - Rate limiting applies to oldPassphrase verification only (wrong newPassphrase
 *   is a validation error, not an authentication attempt).
 * - Origin check: cross-origin browser requests are rejected with 403.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/security/origin";
import { checkRateLimit, recordFailure, recordSuccess } from "@/lib/security/rate-limit";
import { rotateVaultKey, VaultDecryptError, VaultNotInitError } from "@/lib/vault";

const RotateInputSchema = z.object({
  oldPassphrase: z.string().min(1),
  newPassphrase: z.string().min(1),
});

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

  const parsed = RotateInputSchema.safeParse(body);
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
    const result = await rotateVaultKey(parsed.data.oldPassphrase, parsed.data.newPassphrase);
    recordSuccess(ipKey);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VaultDecryptError) {
      // Only the oldPassphrase verification counts as an auth failure.
      recordFailure(ipKey);
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Wrong passphrase." } },
        { status: 401 },
      );
    }
    if (err instanceof VaultNotInitError) {
      return NextResponse.json(
        {
          error: {
            code: "VAULT_NOT_INIT",
            message: "Vault has not been initialised. Unlock first.",
          },
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
