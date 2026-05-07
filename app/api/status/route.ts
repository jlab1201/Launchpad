/**
 * GET /api/status          — bulk status for all webapps
 * GET /api/status?id=<id>  — single webapp status
 * GET /api/status?refresh=1 — bypass cache (works with or without id)
 *
 * Returns StatusResult shape from lib/contracts.ts.
 */

import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { webapps } from "@/lib/db/schema";
import { invalidateStatusCache, runStatusCheck, runStatusCheckAll } from "@/lib/status";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const refresh = searchParams.get("refresh") === "1";

  try {
    if (id) {
      // Single-app path.
      const db = getDb();
      const app = await db.query.webapps.findFirst({ where: eq(webapps.id, id) });

      if (!app) {
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: `Webapp ${id} not found` } },
          { status: 404 },
        );
      }

      if (refresh) {
        invalidateStatusCache(id);
      }

      const result = await runStatusCheck(id);
      return NextResponse.json({ data: result });
    }

    // Bulk path.
    if (refresh) {
      invalidateStatusCache();
    }

    const resultMap = await runStatusCheckAll();
    const data: Record<string, unknown> = {};
    for (const [key, value] of resultMap) {
      data[key] = value;
    }
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: "Status check failed" } },
      { status: 500 },
    );
  }
}
