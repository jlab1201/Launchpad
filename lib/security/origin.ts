/**
 * lib/security/origin.ts
 *
 * Origin check helper for mutation endpoints.
 *
 * When a browser sends a cross-site request it includes an Origin header.
 * Non-browser clients (curl, server-to-server) typically omit it — those are
 * allowed through.  If Origin is present, its host must exactly match the
 * Host header or the request is rejected with 403.
 *
 * Usage: place at the top of every POST/PATCH/DELETE handler:
 *
 *   const deny = assertSameOrigin(req);
 *   if (deny) return deny;
 */
import { type NextRequest, NextResponse } from "next/server";

export function assertSameOrigin(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin");

  // No Origin header → non-browser / server-to-server call → allow.
  if (!origin) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Malformed Origin — reject.
    return NextResponse.json(
      { error: { code: "FORBIDDEN_ORIGIN", message: "Invalid Origin header." } },
      { status: 403 },
    );
  }

  const host = req.headers.get("host") ?? "";

  if (originHost !== host) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN_ORIGIN", message: "Cross-origin request rejected." } },
      { status: 403 },
    );
  }

  return null;
}
