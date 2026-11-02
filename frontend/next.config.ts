import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // All data is runtime (live orders, rewards, catalog) — no static prerendering of data.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    // Static assets are content-addressed (_next/static) or rarely changed (brand media),
    // so let browsers keep them instead of revalidating on every visit.
    return [
      {
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/brand/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
  async rewrites() {
    // Proxy API calls same-origin so no CORS is needed. The backend lives in
    // this repo (../backend) and listens on PORT (default 3000). Override with
    // API_ORIGIN only when the API runs elsewhere (e.g. the build server).
    const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3000";
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
