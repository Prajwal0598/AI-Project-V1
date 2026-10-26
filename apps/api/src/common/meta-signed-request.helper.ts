import { createHmac, timingSafeEqual } from "node:crypto";

export interface MetaSignedRequestPayload {
  /** Facebook app-scoped user id — only meaningful to this app, and the only identifier Meta's callbacks carry. */
  userId: string;
  issuedAt: Date | null;
}

export type MetaSignedRequestResult =
  | { ok: true; payload: MetaSignedRequestPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "unsupported_algorithm" | "missing_user_id" };

const MAX_LENGTH = 4096;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The shape of an app-scoped Meta user id we are willing to store or compare; anything else is rejected, never sanitised. */
export function isValidMetaUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID.test(value);
}

/**
 * Verifies and decodes a Meta `signed_request` ("<base64url HMAC-SHA256 signature>.<base64url JSON payload>", the signature
 * keyed with the app secret over the payload text exactly as received). The signature is checked BEFORE the payload is
 * parsed, so nothing inside an unsigned request is ever trusted. The failure reason never echoes any part of the input.
 */
export function parseMetaSignedRequest(raw: unknown, appSecret: string): MetaSignedRequestResult {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return { ok: false, reason: "malformed" };
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encodedSignature, encodedPayload] = parts;
  if (!BASE64URL.test(encodedSignature) || !BASE64URL.test(encodedPayload)) return { ok: false, reason: "malformed" };

  const signature = Buffer.from(encodedSignature, "base64url");
  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return { ok: false, reason: "bad_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: "malformed" };
  const data = payload as Record<string, unknown>;

  if (typeof data.algorithm !== "string" || data.algorithm.toUpperCase() !== "HMAC-SHA256") return { ok: false, reason: "unsupported_algorithm" };

  // a JSON number above 2^53 has already lost digits, so only a string or a safe integer can be trusted as an id
  const rawUserId = typeof data.user_id === "number" && Number.isSafeInteger(data.user_id) ? String(data.user_id) : data.user_id;
  if (typeof rawUserId !== "string" || !USER_ID.test(rawUserId)) return { ok: false, reason: "missing_user_id" };

  const issuedAt = typeof data.issued_at === "number" && Number.isFinite(data.issued_at) && data.issued_at > 0 ? new Date(data.issued_at * 1000) : null;
  return { ok: true, payload: { userId: rawUserId, issuedAt } };
}
