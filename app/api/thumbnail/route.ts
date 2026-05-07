/**
 * POST /api/thumbnail/refresh?id=<appId>
 *   Triggers an immediate Playwright screenshot capture for the given app.
 *   Returns { status: "ok", thumbnailUrl, capturedAt } or { status: "error", error }.
 *   404 if the appId is unknown (the runner returns an error string containing
 *   "not found" — we check for that pattern to distinguish 404 from 500).
 *
 * GET /api/thumbnail?id=<appId>
 *   Alias for the static file route — kept here for backwards compat.
 *   Prefer GET /api/thumbnail/<id> for direct image streaming.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { webapps as webappsTable } from "@/lib/db/schema";
import { triggerRefresh } from "@/lib/thumbnails/scheduler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { status: "error", error: "Missing required query param: id" },
      { status: 400 },
    );
  }

  // Verify the webapp exists before invoking Playwright.
  const db = getDb();
  const webapp = await db.query.webapps.findFirst({
    where: eq(webappsTable.id, id),
    columns: { id: true },
  });

  if (!webapp) {
    return NextResponse.json({ status: "error", error: `App ${id} not found` }, { status: 404 });
  }

  const result = await triggerRefresh(id);

  if ("error" in result) {
    const isNotFound = result.error.includes("not found");
    return NextResponse.json(
      { status: "error", error: result.error },
      { status: isNotFound ? 404 : 500 },
    );
  }

  return NextResponse.json({
    status: "ok",
    thumbnailUrl: result.thumbnailUrl,
    capturedAt: result.capturedAt,
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { status: "error", error: "Missing required query param: id" },
      { status: 400 },
    );
  }

  const safeId = path.basename(id);
  const dir = process.env.THUMBNAIL_DIR ?? "./data/thumbnails";
  const filePath = path.resolve(dir, `${safeId}.png`);

  if (!existsSync(filePath)) {
    return NextResponse.json({ status: "error", error: "Thumbnail not found" }, { status: 404 });
  }

  // Redirect to the streaming route.
  return NextResponse.redirect(new URL(`/api/thumbnail/${safeId}`, request.url));
}
