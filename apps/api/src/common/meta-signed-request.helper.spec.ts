import { createHmac } from "node:crypto";
import { parseMetaSignedRequest } from "./meta-signed-request.helper";

const SECRET = "test-app-secret-not-real";
const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = b64u(JSON.stringify(payload));
  return `${b64u(createHmac("sha256", secret).update(encoded).digest())}.${encoded}`;
}

describe("parseMetaSignedRequest", () => {
  const valid = { algorithm: "HMAC-SHA256", issued_at: 1_790_000_000, user_id: "1234567890123456" };

  it("accepts a correctly signed request and returns the app-scoped user id and issue time", () => {
    expect(parseMetaSignedRequest(sign(valid), SECRET)).toEqual({ ok: true, payload: { userId: "1234567890123456", issuedAt: new Date(1_790_000_000_000) } });
  });

  it("rejects a request signed with a different secret", () => {
    expect(parseMetaSignedRequest(sign(valid, "another-apps-secret"), SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a payload that was altered after signing", () => {
    const [signature] = sign(valid).split(".");
    const forged = `${signature}.${b64u(JSON.stringify({ ...valid, user_id: "999" }))}`;
    expect(parseMetaSignedRequest(forged, SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("verifies the signature before reading anything inside the payload", () => {
    // an unsigned payload with an unsupported algorithm must be reported as a bad signature, not as an algorithm problem
    const encoded = b64u(JSON.stringify({ algorithm: "none", user_id: "1" }));
    expect(parseMetaSignedRequest(`${b64u("x".repeat(32))}.${encoded}`, SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["not a string", 42],
    ["undefined", undefined],
    ["empty", ""],
    ["no separator", "abcdef"],
    ["three parts", "a.b.c"],
    ["characters outside base64url", "ab+/.cd=="],
    ["oversized", `${"a".repeat(5000)}.${"b".repeat(10)}`],
  ])("treats %s as malformed", (_label, value) => {
    expect(parseMetaSignedRequest(value, SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a signed payload that is not a JSON object", () => {
    const encoded = b64u("not json");
    const signed = `${b64u(createHmac("sha256", SECRET).update(encoded).digest())}.${encoded}`;
    expect(parseMetaSignedRequest(signed, SECRET)).toEqual({ ok: false, reason: "malformed" });
    expect(parseMetaSignedRequest(sign([1, 2] as unknown as Record<string, unknown>), SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an unsupported algorithm even when correctly signed", () => {
    expect(parseMetaSignedRequest(sign({ ...valid, algorithm: "HMAC-SHA1" }), SECRET)).toEqual({ ok: false, reason: "unsupported_algorithm" });
    expect(parseMetaSignedRequest(sign({ user_id: "1" }), SECRET)).toEqual({ ok: false, reason: "unsupported_algorithm" });
  });

  it("accepts the algorithm name in any letter case", () => {
    expect(parseMetaSignedRequest(sign({ ...valid, algorithm: "hmac-sha256" }), SECRET).ok).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["an object", { id: 1 }],
    ["a number too large to hold exactly", 12345678901234567890],
    ["containing characters outside the safe set", "12 34; DROP TABLE"],
    ["too long", "1".repeat(65)],
  ])("requires a usable user_id (%s)", (_label, userId) => {
    expect(parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: userId }), SECRET)).toEqual({ ok: false, reason: "missing_user_id" });
  });

  it("accepts a safe-integer user_id and converts it to a string", () => {
    const result = parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: 218471 }), SECRET);
    expect(result).toEqual({ ok: true, payload: { userId: "218471", issuedAt: null } });
  });

  it("treats a missing or invalid issued_at as unknown rather than failing", () => {
    for (const issued_at of [undefined, "yesterday", -5, 0]) {
      const result = parseMetaSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1", issued_at }), SECRET);
      expect(result).toEqual({ ok: true, payload: { userId: "1", issuedAt: null } });
    }
  });

  it("never echoes any part of the input in a failure", () => {
    const result = parseMetaSignedRequest(sign(valid, "another-apps-secret"), SECRET);
    expect(JSON.stringify(result)).not.toContain("1234567890123456");
  });
});
