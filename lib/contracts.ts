/**
 * lib/contracts.ts — Zod schemas and inferred TS types.
 *
 * These are the inter-agent contracts. frontend-dev and integration-specialist
 * import types from here. API route handlers validate against these schemas.
 * Never import from Next.js or browser globals here — this file is shared
 * between server and client code.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// AuthType
// ---------------------------------------------------------------------------
export const AuthTypeSchema = z.enum(["none", "basic", "bearer"]);
export type AuthType = z.infer<typeof AuthTypeSchema>;

// ---------------------------------------------------------------------------
// CredentialKind
// ---------------------------------------------------------------------------
export const CredentialKindSchema = z.enum(["password", "token", "cookie", "note"]);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

// ---------------------------------------------------------------------------
// Webapp — the public representation of a registered webapp
// (no credential payload; ciphertext never leaves the server)
// ---------------------------------------------------------------------------
export const WebappSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  url: z.string().url(),
  authType: AuthTypeSchema,
  autoScreenshot: z.boolean(),
  /** Optional override URL for the thumbnail screenshot. Falls back to `url` when null. */
  thumbnailUrl: z.string().url().nullable(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});
export type Webapp = z.infer<typeof WebappSchema>;

// ---------------------------------------------------------------------------
// RegisterAppInput — payload to POST /api/apps
//
// Accepts an optional credential payload at registration time. The credential
// is validated here as plaintext, then immediately encrypted by the vault layer
// before any persistence. It MUST NOT be stored anywhere after the vault call.
//
// credentialPayload is a discriminated union so TypeScript flags mismatched
// kinds at compile time.
// ---------------------------------------------------------------------------
const BasicCredentialSchema = z.object({
  kind: z.literal("password"),
  username: z.string().min(1),
  password: z.string().min(1),
});

const BearerCredentialSchema = z.object({
  kind: z.literal("token"),
  token: z.string().min(1),
});

// cookie and note are accepted in schema for future phases; no handler in v1.
const CookieCredentialSchema = z.object({
  kind: z.literal("cookie"),
  cookieHeader: z.string().min(1),
});

const NoteCredentialSchema = z.object({
  kind: z.literal("note"),
  text: z.string().min(1),
});

export const CredentialPayloadSchema = z.discriminatedUnion("kind", [
  BasicCredentialSchema,
  BearerCredentialSchema,
  CookieCredentialSchema,
  NoteCredentialSchema,
]);
export type CredentialPayload = z.infer<typeof CredentialPayloadSchema>;

export const RegisterAppInputSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  authType: AuthTypeSchema,
  autoScreenshot: z.boolean().default(true),
  /**
   * Optional URL the screenshot service should capture instead of `url`.
   * Use this to pin the thumbnail to a specific deep page. Empty string is
   * accepted and treated as null.
   */
  thumbnailUrl: z
    .union([z.string().url(), z.literal("")])
    .nullable()
    .optional(),
  /**
   * Optional credential to store at registration time.
   * Must match `authType`:
   *   - none    → omit or null
   *   - basic   → kind: "password"
   *   - bearer  → kind: "token"
   * The vault must be unlocked to accept a credential.
   */
  credential: CredentialPayloadSchema.optional(),
});
export type RegisterAppInput = z.infer<typeof RegisterAppInputSchema>;

// Patch input: all fields optional except id comes from the route param.
export const PatchAppInputSchema = RegisterAppInputSchema.partial();
export type PatchAppInput = z.infer<typeof PatchAppInputSchema>;

// ---------------------------------------------------------------------------
// StatusResult — returned by GET /api/status?id=<appId>
// ---------------------------------------------------------------------------
export const StatusResultSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().int().nullable(),
  latencyMs: z.number().nullable(),
  lastCheckedAt: z.number().int().positive(),
  error: z.string().nullable(),
});
export type StatusResult = z.infer<typeof StatusResultSchema>;

// ---------------------------------------------------------------------------
// VaultUnlockInput — payload to POST /api/vault (action: "unlock")
// ---------------------------------------------------------------------------
export const VaultUnlockInputSchema = z.object({
  passphrase: z.string().min(1),
});
export type VaultUnlockInput = z.infer<typeof VaultUnlockInputSchema>;

// ---------------------------------------------------------------------------
// API response envelopes — consistent shape across all endpoints
// ---------------------------------------------------------------------------
export const ApiSuccessSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema,
    meta: z
      .object({
        total: z.number().int().optional(),
        page: z.number().int().optional(),
      })
      .optional(),
  });

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
