/**
 * Sanity test — verifies that Zod contracts parse and round-trip correctly.
 *
 * This is the Phase 1 acceptance test. It does NOT require a running server
 * or database — it only exercises the Zod schemas in lib/contracts.ts.
 */
import { describe, expect, it } from "vitest";
import {
  AuthTypeSchema,
  CredentialKindSchema,
  RegisterAppInputSchema,
  StatusResultSchema,
  VaultUnlockInputSchema,
  WebappSchema,
} from "@/lib/contracts";

describe("WebappSchema", () => {
  it("parses a valid webapp object", () => {
    const raw = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Grafana",
      url: "http://localhost:3000",
      authType: "basic",
      autoScreenshot: true,
      thumbnailUrl: null,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    const result = WebappSchema.parse(raw);
    expect(result.name).toBe("Grafana");
    expect(result.authType).toBe("basic");
    expect(result.thumbnailUrl).toBe(null);
  });

  it("accepts a thumbnailUrl override", () => {
    const result = WebappSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Grafana",
      url: "http://localhost:3000",
      authType: "none",
      autoScreenshot: true,
      thumbnailUrl: "http://localhost:3000/d/team",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    expect(result.thumbnailUrl).toBe("http://localhost:3000/d/team");
  });

  it("rejects an invalid URL", () => {
    expect(() =>
      WebappSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Bad",
        url: "not-a-url",
        authType: "none",
        autoScreenshot: false,
        thumbnailUrl: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      }),
    ).toThrow();
  });
});

describe("RegisterAppInputSchema", () => {
  it("round-trips a basic-auth registration", () => {
    const input = {
      name: "Internal App",
      url: "https://internal.example.com",
      authType: "basic" as const,
      autoScreenshot: true,
      credential: {
        kind: "password" as const,
        username: "admin",
        password: "s3cret",
      },
    };
    const parsed = RegisterAppInputSchema.parse(input);
    expect(parsed.credential).toBeDefined();
    if (parsed.credential?.kind === "password") {
      expect(parsed.credential.username).toBe("admin");
    }
  });

  it("round-trips a bearer-token registration", () => {
    const input = {
      name: "API Service",
      url: "https://api.example.com",
      authType: "bearer" as const,
      credential: { kind: "token" as const, token: "tok_abc123" },
    };
    const parsed = RegisterAppInputSchema.parse(input);
    expect(parsed.autoScreenshot).toBe(true); // default applied
  });

  it("accepts no credential for public apps", () => {
    const parsed = RegisterAppInputSchema.parse({
      name: "Public Site",
      url: "https://example.com",
      authType: "none",
    });
    expect(parsed.credential).toBeUndefined();
  });
});

describe("StatusResultSchema", () => {
  it("parses a successful status result", () => {
    const raw = {
      ok: true,
      statusCode: 200,
      latencyMs: 45.2,
      lastCheckedAt: Date.now(),
      error: null,
    };
    const result = StatusResultSchema.parse(raw);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it("parses a failed status result", () => {
    const raw = {
      ok: false,
      statusCode: null,
      latencyMs: null,
      lastCheckedAt: Date.now(),
      error: "ECONNREFUSED",
    };
    const result = StatusResultSchema.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});

describe("VaultUnlockInputSchema", () => {
  it("accepts a non-empty passphrase", () => {
    const result = VaultUnlockInputSchema.parse({ passphrase: "my-secure-passphrase" });
    expect(result.passphrase).toBe("my-secure-passphrase");
  });

  it("rejects an empty passphrase", () => {
    expect(() => VaultUnlockInputSchema.parse({ passphrase: "" })).toThrow();
  });
});

describe("AuthTypeSchema", () => {
  it("accepts all valid auth types", () => {
    expect(AuthTypeSchema.parse("none")).toBe("none");
    expect(AuthTypeSchema.parse("basic")).toBe("basic");
    expect(AuthTypeSchema.parse("bearer")).toBe("bearer");
  });

  it("rejects unknown auth types", () => {
    expect(() => AuthTypeSchema.parse("oauth2")).toThrow();
  });
});

describe("CredentialKindSchema", () => {
  it("accepts all four credential kinds", () => {
    expect(CredentialKindSchema.parse("password")).toBe("password");
    expect(CredentialKindSchema.parse("token")).toBe("token");
    expect(CredentialKindSchema.parse("cookie")).toBe("cookie");
    expect(CredentialKindSchema.parse("note")).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// Invalid-shape rejection tests (coverage hole: every schema must reject bad input)
// ---------------------------------------------------------------------------

describe("WebappSchema — rejects invalid shapes", () => {
  it("rejects missing required fields", () => {
    // id is required
    expect(() =>
      WebappSchema.parse({ name: "X", url: "http://x.com", authType: "none" }),
    ).toThrow();
  });

  it("rejects name that is empty string", () => {
    expect(() =>
      WebappSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "",
        url: "http://x.com",
        authType: "none",
        autoScreenshot: false,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      }),
    ).toThrow();
  });

  it("rejects a non-uuid id", () => {
    expect(() =>
      WebappSchema.parse({
        id: "not-a-uuid",
        name: "Test",
        url: "http://x.com",
        authType: "none",
        autoScreenshot: false,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      }),
    ).toThrow();
  });
});

describe("RegisterAppInputSchema — rejects invalid shapes", () => {
  it("rejects missing name", () => {
    expect(() =>
      RegisterAppInputSchema.parse({
        url: "http://x.com",
        authType: "none",
      }),
    ).toThrow();
  });

  it("rejects missing url", () => {
    expect(() =>
      RegisterAppInputSchema.parse({
        name: "Test",
        authType: "none",
      }),
    ).toThrow();
  });

  it("rejects invalid auth type", () => {
    expect(() =>
      RegisterAppInputSchema.parse({
        name: "Test",
        url: "http://x.com",
        authType: "apikey",
      }),
    ).toThrow();
  });

  it("rejects a token credential with an empty token string", () => {
    expect(() =>
      RegisterAppInputSchema.parse({
        name: "Test",
        url: "http://x.com",
        authType: "bearer",
        credential: { kind: "token", token: "" },
      }),
    ).toThrow();
  });

  it("rejects a password credential with empty username", () => {
    expect(() =>
      RegisterAppInputSchema.parse({
        name: "Test",
        url: "http://x.com",
        authType: "basic",
        credential: { kind: "password", username: "", password: "secret" },
      }),
    ).toThrow();
  });
});

describe("StatusResultSchema — rejects invalid shapes", () => {
  it("rejects missing ok field", () => {
    expect(() =>
      StatusResultSchema.parse({
        statusCode: 200,
        latencyMs: 10,
        lastCheckedAt: Date.now(),
        error: null,
      }),
    ).toThrow();
  });

  it("rejects non-positive lastCheckedAt", () => {
    expect(() =>
      StatusResultSchema.parse({
        ok: true,
        statusCode: 200,
        latencyMs: 10,
        lastCheckedAt: 0,
        error: null,
      }),
    ).toThrow();
  });
});

describe("VaultUnlockInputSchema — rejects invalid shapes", () => {
  it("rejects a non-string passphrase", () => {
    expect(() => VaultUnlockInputSchema.parse({ passphrase: 12345 })).toThrow();
  });

  it("rejects a missing passphrase field", () => {
    expect(() => VaultUnlockInputSchema.parse({})).toThrow();
  });
});
