/**
 * /api/vault — base vault route (kept for backward compat; Phase 2 routes
 * are under /api/vault/unlock, /api/vault/lock, /api/vault/rotate, /api/vault/status)
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { error: { code: "NOT_FOUND", message: "Use /api/vault/status for vault status." } },
    { status: 404 },
  );
}

export async function POST() {
  return NextResponse.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Use /api/vault/unlock, /api/vault/lock, or /api/vault/rotate.",
      },
    },
    { status: 404 },
  );
}
