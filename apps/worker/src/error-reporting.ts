import * as Sentry from "@sentry/node";

/** Mirrors apps/api's error-reporting helper — a no-op unless SENTRY_DSN is set. */
export function initErrorReporting(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  Sentry.init({ dsn, environment: process.env.NODE_ENV ?? "development", tracesSampleRate: 0.1 });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!process.env.SENTRY_DSN?.trim()) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
