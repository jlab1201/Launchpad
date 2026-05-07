/**
 * GET  /api/apps — list all registered webapps (no credential data)
 * POST /api/apps — register a new webapp (optionally with credentials)
 *
 * SECURITY CONTRACT:
 * - GET never returns ciphertext, nonce, or any credential field.
 * - POST: if credential payload is included and vault is locked → 423 Locked.
 * - POST: on success, only { id, kind } is returned for the credential record.
 *   The plaintext payload is consumed by vault.encryptCredential and never stored.
 */
import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { RegisterAppInputSchema } from "@/lib/contracts";
import { getDb } from "@/lib/db/client";
import { credentials, webapps } from "@/lib/db/schema";
import { assertSameOrigin } from "@/lib/security/origin";
import { encryptCredential, VaultLockedError } from "@/lib/vault";

export async function GET() {
  const db = getDb();
  const rows = await db.query.webapps.findMany({
    orderBy: (w, { asc }) => [asc(w.createdAt)],
  });

  // Map DB rows to the Webapp contract shape.
  const apps = rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    authType: row.authType,
    autoScreenshot: row.autoScreenshot === 1,
    thumbnailUrl: row.thumbnailUrl ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));

  return NextResponse.json({ data: apps, meta: { total: apps.length } });
}

export async function POST(req: NextRequest) {
  const deny = assertSameOrigin(req);
  if (deny) return deny;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  const parsed = RegisterAppInputSchema.safeParse(body);
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

  // Validate that credential.kind is consistent with authType.
  if (input.credential) {
    const { authType, credential } = input;
    const kindOk =
      (authType === "basic" && credential.kind === "password") ||
      (authType === "bearer" && credential.kind === "token");
    if (!kindOk) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed.",
            details: {
              credential: [
                `Credential kind "${credential.kind}" is not valid for authType "${authType}". ` +
                  `Expected: basic → password, bearer → token.`,
              ],
            },
          },
        },
        { status: 422 },
      );
    }
  }

  const appId = crypto.randomUUID();
  const now = Date.now();
  // Normalise empty string → null so the DB stores NULL, not "".
  const thumbnailUrl =
    input.thumbnailUrl && input.thumbnailUrl.length > 0 ? input.thumbnailUrl : null;

  // If a credential payload is provided, vault must be unlocked.
  if (input.credential) {
    try {
      const encrypted = await encryptCredential(input.credential);

      const db = getDb();
      const credId = crypto.randomUUID();

      // Insert webapp + credential in a single transaction.
      const sqlite = db.$client as import("better-sqlite3").Database;
      sqlite.transaction(() => {
        db.insert(webapps)
          .values({
            id: appId,
            name: input.name,
            url: input.url,
            authType: input.authType,
            autoScreenshot: input.autoScreenshot ? 1 : 0,
            thumbnailUrl,
          })
          .run();

        db.insert(credentials)
          .values({
            id: credId,
            webappId: appId,
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            kind: input.credential?.kind ?? "password",
          })
          .run();
      })();

      return NextResponse.json(
        {
          data: {
            webapp: {
              id: appId,
              name: input.name,
              url: input.url,
              authType: input.authType,
              autoScreenshot: input.autoScreenshot,
              thumbnailUrl,
              createdAt: now,
              updatedAt: now,
            },
            credential: { id: credId, kind: input.credential.kind },
          },
        },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof VaultLockedError) {
        return NextResponse.json({ error: "vault_locked" }, { status: 423 });
      }
      throw err;
    }
  }

  // No credential — insert webapp only.
  const db = getDb();

  await db.insert(webapps).values({
    id: appId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    autoScreenshot: input.autoScreenshot ? 1 : 0,
    thumbnailUrl,
  });

  return NextResponse.json(
    {
      data: {
        webapp: {
          id: appId,
          name: input.name,
          url: input.url,
          authType: input.authType,
          autoScreenshot: input.autoScreenshot,
          thumbnailUrl,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
    { status: 201 },
  );
}
