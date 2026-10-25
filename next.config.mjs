/** @type {import('next').NextConfig} */
const nextConfig = {
  // Several dev servers can share this checkout (one per engineer) when each sets its own dist dir.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  // Emit a self-contained server in .next/standalone so the Docker image ships
  // only the traced production modules instead of the full node_modules tree.
  output: "standalone",
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
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
