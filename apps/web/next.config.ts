import type { NextConfig } from "next";

// standalone output bundles only the traced production dependencies into .next/standalone,
// so the Docker runtime image doesn't need the full node_modules tree copied in
const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
