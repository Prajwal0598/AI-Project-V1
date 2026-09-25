import * as Sentry from "@sentry/node";

/** Initializes Sentry error reporting — a no-op everywhere else in the app if SENTRY_DSN isn't set, exactly
 * like every other optional integration in this codebase (OpenAI, Razorpay, per-business channel tokens). */
export function initErrorReporting(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  Sentry.init({ dsn, environment: process.env.NODE_ENV ?? "development", tracesSampleRate: 0.1 });
}

export function isErrorReportingConfigured(): boolean {
  return !!process.env.SENTRY_DSN?.trim();
}

/** Reports an exception with optional context (never throws itself, and does nothing if Sentry isn't configured). */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!isErrorReportingConfigured()) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
