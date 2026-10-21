/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Emit a self-contained server in .next/standalone so the Docker image ships
  // only the traced production modules instead of the full node_modules tree.
  output: "standalone",
  // ClinicMind can be embedded on a clinic's own website or inside another
  // portal of theirs. We therefore do NOT globally
  // deny framing. Per-route framing policy is enforced in src/proxy.ts where the
  // embed surface (/embed/*) is allowed to be framed by the tenant's allowed origins
  // and everything else stays same-origin only.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
    ];
  },
};

export default nextConfig;
