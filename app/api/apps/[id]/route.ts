/**
 * GET    /api/apps/[id] — fetch a single webapp (no credential data)
 * PATCH  /api/apps/[id] — partial update; replaces credential if vault unlocked
 * DELETE /api/apps/[id] — removes webapp and cascades to credentials
 *
 * SECURITY CONTRACT:
 * - GET and PATCH responses NEVER include ciphertext, nonce, or plaintext credentials.
 * - PATCH: if a new credential payload is included and vault is locked → 423 Locked.
 */
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { PatchAppInputSchema } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { credentials, webapps } from "@/lib/db/schema";
import { assertSameOrigin } from "@/lib/security/origin";
import { encryptCredential, VaultLockedError } from "@/lib/vault";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const db = getDb();

  const webapp = await db.query.webapps.findFirst({ where: eq(webapps.id, id) });
  if (!webapp) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Webapp not found." } },
      { status: 404 },
    );
  }

  return NextResponse.json({
    data: {
      id: webapp.id,
      name: webapp.name,
      url: webapp.url,
      authType: webapp.authType,
      autoScreenshot: webapp.autoScreenshot === 1,
      thumbnailUrl: webapp.thumbnailUrl ?? null,
      createdAt: webapp.createdAt,
      updatedAt: webapp.updatedAt,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const deny = assertSameOrigin(req);
  if (deny) return deny;

  const { id } = await params;
  const db = getDb();

  const existing = await db.query.webapps.findFirst({ where: eq(webapps.id, id) });
  if (!existing) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Webapp not found." } },
      { status: 404 },
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

  const parsed = PatchAppInputSchema.safeParse(body);
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

  const input = parsed.data;

  // Validate that credential.kind is consistent with the authType being set.
  // Use the incoming authType if provided, otherwise fall back to the existing row's authType.
  if (input.credential) {
    const effectiveAuthType = input.authType ?? existing.authType;
    const { credential } = input;
    const kindOk =
      (effectiveAuthType === "basic" && credential.kind === "password") ||
      (effectiveAuthType === "bearer" && credential.kind === "token");
    if (!kindOk) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed.",
            details: {
              credential: [
                `Credential kind "${credential.kind}" is not valid for authType "${effectiveAuthType}". ` +
                  `Expected: basic → password, bearer → token.`,
              ],
            },
          },
        },
        { status: 422 },
      );
    }
  }

  const now = Date.now();

  // Normalise thumbnailUrl: empty string → null. `undefined` means "not in patch".
  const thumbnailUrlPatched = input.thumbnailUrl !== undefined;
  const thumbnailUrlValue =
    input.thumbnailUrl && input.thumbnailUrl.length > 0 ? input.thumbnailUrl : null;

  // Build the merged webapp fields for the response (before writing to DB).
  const updatedWebapp = {
    id: existing.id,
    name: input.name ?? existing.name,
    url: input.url ?? existing.url,
    authType: input.authType ?? existing.authType,
    autoScreenshot:
      input.autoScreenshot !== undefined ? input.autoScreenshot : existing.autoScreenshot === 1,
    thumbnailUrl: thumbnailUrlPatched ? thumbnailUrlValue : (existing.thumbnailUrl ?? null),
    createdAt: existing.createdAt,
    updatedAt: now,
  };

  // If a new credential is included, encrypt it (will throw if vault locked).
  if (input.credential) {
    let encrypted: { ciphertext: Buffer; nonce: Buffer };
    try {
      encrypted = await encryptCredential(input.credential);
    } catch (err) {
      if (err instanceof VaultLockedError) {
        return NextResponse.json(
          {
            error: {
              code: "VAULT_LOCKED",
              message: "Vault is locked. Unlock it before saving credentials.",
            },
          },
          { status: 423 },
        );
      }
      throw err;
    }

    const sqlite = db.$client as import("better-sqlite3").Database;
    sqlite.transaction(() => {
      db.update(webapps)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.url !== undefined && { url: input.url }),
          ...(input.authType !== undefined && { authType: input.authType }),
          ...(input.autoScreenshot !== undefined && {
            autoScreenshot: input.autoScreenshot ? 1 : 0,
          }),
          ...(thumbnailUrlPatched && { thumbnailUrl: thumbnailUrlValue }),
          updatedAt: now,
        })
        .where(eq(webapps.id, id))
        .run();

      // Replace credential: delete old row(s) and insert new one.
      db.delete(credentials).where(eq(credentials.webappId, id)).run();
      db.insert(credentials)
        .values({
          id: crypto.randomUUID(),
          webappId: id,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce,
          kind: input.credential?.kind ?? "password",
        })
        .run();
    })();
  } else {
    await db
      .update(webapps)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.authType !== undefined && { authType: input.authType }),
        ...(input.autoScreenshot !== undefined && {
          autoScreenshot: input.autoScreenshot ? 1 : 0,
        }),
        ...(thumbnailUrlPatched && { thumbnailUrl: thumbnailUrlValue }),
        updatedAt: now,
      })
      .where(eq(webapps.id, id));
  }

  return NextResponse.json({ data: updatedWebapp });
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const deny = assertSameOrigin(req);
  if (deny) return deny;

  const { id } = await params;
  const db = getDb();

  const existing = await db.query.webapps.findFirst({ where: eq(webapps.id, id) });
  if (!existing) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Webapp not found." } },
      { status: 404 },
    );
  }

  // The credentials table has ON DELETE CASCADE so credentials are removed automatically.
  await db.delete(webapps).where(eq(webapps.id, id));

  return NextResponse.json({ data: { deleted: true } });
}
