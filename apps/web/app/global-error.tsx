"use client";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Next.js App Router's top-level error boundary — reports uncaught render errors to Sentry (a no-op if
// NEXT_PUBLIC_SENTRY_DSN isn't set) before showing a plain fallback screen
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "sans-serif" }}>
          <div style={{ textAlign: "center" }}>
            <h1>Something went wrong</h1>
            <p>Please refresh the page. Our team has been notified.</p>
          </div>
        </div>
      </body>
    </html>
  );
}
