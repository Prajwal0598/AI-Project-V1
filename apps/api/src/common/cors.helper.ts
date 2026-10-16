import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

// Used when WEB_ORIGIN is not set at all (local development) — never added on top of a configured WEB_ORIGIN
export const DEFAULT_WEB_ORIGIN = "http://localhost:3000";

/** An exact http(s) origin ("https://host[:port]"), normalised; null for "*", a bare hostname, another scheme, or garbage. */
function toOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * WEB_ORIGIN is a comma-separated list of exact web origins, e.g. "https://relayshift.in,https://www.relayshift.in".
 * Entries are trimmed, normalised (lower-case host, trailing slash removed) and de-duplicated, in order. Anything that
 * is not an exact origin — including "*" — is reported in `ignored` and never allowed.
 */
export function parseWebOrigins(raw: string | undefined): { origins: string[]; ignored: string[] } {
  if (raw === undefined) return { origins: [DEFAULT_WEB_ORIGIN], ignored: [] };
  const origins: string[] = [];
  const ignored: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const origin = toOrigin(value);
    if (!origin) ignored.push(value);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, ignored };
}

/** The origin used to build links back to the web app (first entry of WEB_ORIGIN). */
export function primaryWebOrigin(raw: string | undefined): string {
  return parseWebOrigins(raw).origins[0] ?? DEFAULT_WEB_ORIGIN;
}

/** CORS options for the API: only the exact origins from WEB_ORIGIN, with credentials — never a wildcard. */
export function resolveCors(raw: string | undefined): { options: CorsOptions; origins: string[]; ignored: string[] } {
  const { origins, ignored } = parseWebOrigins(raw);
  // an explicit list is matched exactly against the request's Origin; with nothing valid configured, CORS is switched off
  return { options: { origin: origins.length ? origins : false, credentials: true }, origins, ignored };
}
