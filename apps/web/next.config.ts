import type { NextConfig } from "next";

const apiOrigin = (
  process.env.API_INTERNAL_ORIGIN || "http://localhost:4000"
).replace(/\/+$/, "");

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  poweredByHeader: false,
  logging: {
    incomingRequests: {
      ignore: [/^\/share(?:\/|$)/, /^\/api\/v1\/(?:share|media)(?:\/|$)/],
    },
  },
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: apiOrigin + "/api/v1/:path*" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default config;
