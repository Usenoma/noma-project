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
  // Chrome supports AVIF: it is typically 30-50% smaller than JPEG for the brand art.
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  compiler: {
    // shave bytes and parse time on the client
    removeConsole: process.env.NODE_ENV === "production",
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
        // optimized images are addressed by (src, width, quality): cache them for a month
        source: "/_next/image",
        headers: [{ key: "Cache-Control", value: "public, max-age=2592000, immutable" }],
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
