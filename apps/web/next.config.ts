import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

// standalone output bundles only the traced production dependencies into .next/standalone,
// so the Docker runtime image doesn't need the full node_modules tree copied in
const nextConfig: NextConfig = {
  output: "standalone",
};

// withSentryConfig is safe to apply even when SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN are unset — it only adds
// build-time source-map upload (itself a no-op without SENTRY_AUTH_TOKEN) and request tracing instrumentation
export default withSentryConfig(nextConfig, { silent: true });
