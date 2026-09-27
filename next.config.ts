import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root; a stray lockfile in a parent directory otherwise
  // gets picked up as the root.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
