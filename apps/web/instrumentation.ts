// server + edge Sentry init — no-ops if SENTRY_DSN isn't set, same optional-integration pattern as every
// other credential in this codebase (see apps/api/src/common/error-reporting.helper.ts)
export async function register() {
  if (!process.env.SENTRY_DSN?.trim()) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, tracesSampleRate: 0.1 });
  } else if (process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, tracesSampleRate: 0.1 });
  }
}
