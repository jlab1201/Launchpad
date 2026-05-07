/**
 * GET /api/thumbnail/<id>
 *   Streams the stored PNG for the given app ID from disk.
 *   Returns 404 if the file doesn't exist yet.
 *   Cache-Control: no-cache, must-revalidate so the browser always fetches
 *   the latest version after a refresh.
 */

import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Sanitise: prevent path traversal.
  const safeId = path.basename(id);

  const dir = process.env.THUMBNAIL_DIR ?? "./data/thumbnails";
  const filePath = path.resolve(dir, `${safeId}.png`);

  if (!existsSync(filePath)) {
    return NextResponse.json({ status: "error", error: "Thumbnail not found" }, { status: 404 });
  }

  // Stream the PNG.
  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
}
