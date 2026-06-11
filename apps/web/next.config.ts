import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@growengine/db", "@growengine/core"],
  serverExternalPackages: ["postgres", "ioredis", "bullmq", "minio", "nodemailer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "200mb",
    },
  },
};

export default nextConfig;
