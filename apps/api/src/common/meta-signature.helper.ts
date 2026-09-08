import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw request body, keyed with the app secret).
 * If no app secret is configured, verification is skipped (dev/demo mode) — callers should log when that happens.
 */
export function verifyMetaSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined, appSecret: string | undefined): "skipped" | "valid" | "invalid" {
  if (!appSecret) return "skipped";
  if (!rawBody || !signatureHeader?.startsWith("sha256=")) return "invalid";

  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
  const actual = Buffer.from(signatureHeader);
  if (expected.length !== actual.length) return "invalid";
  return timingSafeEqual(expected, actual) ? "valid" : "invalid";
}
