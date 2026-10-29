/** @type {import('next').NextConfig} */
const nextConfig = {
  // Several dev servers can share this checkout (one per engineer) when each sets its own dist dir.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  // Emit a self-contained server in .next/standalone so the Docker image ships
  // only the traced production modules instead of the full node_modules tree.
  output: "standalone",
  // Shared hosting counts every process and thread of the account against a small limit:
  // scripts/hostinger-build.mjs sets NEXT_BUILD_CPUS so `next build` runs few workers.
  ...(process.env.NEXT_BUILD_CPUS ? { experimental: { cpus: Math.max(1, Number(process.env.NEXT_BUILD_CPUS) || 1) } } : {}),
  // Static security headers. The Content-Security-Policy (including the
  // per-tenant frame-ancestors for /embed/*) is emitted per request by
  // src/proxy.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
      {
        // Patient photos (concierge/files) set their own private cache header.
        source: "/api/:path((?!concierge/files/).*)",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        // The public check-in page takes photos with the phone camera.
        source: "/check-in/:path*",
        headers: [{ key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()" }],
      },
    ];
  },
};

export default nextConfig;
