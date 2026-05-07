import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // Produce a self-contained bundle under .next/standalone for Docker / pm2 deploys.
  output: "standalone",
  // Server-only packages that must not be bundled into the client
  serverExternalPackages: ["better-sqlite3", "@node-rs/argon2", "libsodium-wrappers"],
  // Hide the floating Next.js dev badge in the lower-left.
  devIndicators: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // CSP is production-only: Next.js HMR uses inline scripts/websockets
          // that violate a strict policy in dev.
          ...(isProd
            ? [
                {
                  key: "Content-Security-Policy",
                  value: [
                    "default-src 'self'",
                    "script-src 'self' 'unsafe-inline'", // Next.js still emits some inline runtime; revisit when nonces are wired
                    "style-src 'self' 'unsafe-inline'", // Tailwind's runtime + sonner emit inline styles
                    "img-src 'self' data:",
                    "font-src 'self' data:",
                    "connect-src 'self'",
                    "frame-ancestors 'none'",
                    "form-action 'self'",
                    "base-uri 'self'",
                    "object-src 'none'",
                  ].join("; "),
                },
              ]
            : []),
        ].filter(Boolean),
      },
    ];
  },
};

export default nextConfig;
