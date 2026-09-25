// browser-side Sentry init — no-op if NEXT_PUBLIC_SENTRY_DSN wasn't set at build time
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, tracesSampleRate: 0.1 });
}
