import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Razorpay's X-Razorpay-Signature header — HMAC-SHA256 of the raw request body, keyed with the
 * webhook secret configured in the Razorpay Dashboard. Unlike Meta's signature, there's no "sha256=" prefix.
 */
export function verifyRazorpaySignature(rawBody: Buffer | undefined, signatureHeader: string | undefined, webhookSecret: string | undefined): "skipped" | "valid" | "invalid" {
  if (!webhookSecret) return "skipped";
  if (!rawBody || !signatureHeader) return "invalid";

  const expected = Buffer.from(createHmac("sha256", webhookSecret).update(rawBody).digest("hex"));
  const actual = Buffer.from(signatureHeader);
  if (expected.length !== actual.length) return "invalid";
  return timingSafeEqual(expected, actual) ? "valid" : "invalid";
}
