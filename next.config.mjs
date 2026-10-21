/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // ClinicMind is designed to be embedded as a tab inside host admin dashboards
  // (e.g. the GROW Engine) and on client websites. We therefore do NOT globally
  // deny framing. Per-route framing policy is enforced in middleware.ts where the
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
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
