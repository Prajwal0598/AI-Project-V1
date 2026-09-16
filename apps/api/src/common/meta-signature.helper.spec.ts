import { createHmac } from "node:crypto";
import { verifyMetaSignature } from "./meta-signature.helper";

describe("verifyMetaSignature", () => {
  const appSecret = "test-app-secret";
  const body = Buffer.from(JSON.stringify({ hello: "world" }));

  function sign(secret: string, payload: Buffer): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  it("returns 'skipped' when no app secret is configured", () => {
    expect(verifyMetaSignature(body, sign(appSecret, body), undefined)).toBe("skipped");
  });

  it("returns 'valid' for a correctly signed payload", () => {
    expect(verifyMetaSignature(body, sign(appSecret, body), appSecret)).toBe("valid");
  });

  it("returns 'invalid' for a payload signed with the wrong secret", () => {
    expect(verifyMetaSignature(body, sign("wrong-secret", body), appSecret)).toBe("invalid");
  });

  it("returns 'invalid' when the signature header is missing", () => {
    expect(verifyMetaSignature(body, undefined, appSecret)).toBe("invalid");
  });

  it("returns 'invalid' when the signature header doesn't have the sha256= prefix", () => {
    const raw = createHmac("sha256", appSecret).update(body).digest("hex");
    expect(verifyMetaSignature(body, raw, appSecret)).toBe("invalid");
  });

  it("returns 'invalid' when the raw body is missing", () => {
    expect(verifyMetaSignature(undefined, sign(appSecret, body), appSecret)).toBe("invalid");
  });

  it("returns 'invalid' if the body was tampered with after signing", () => {
    const signature = sign(appSecret, body);
    const tamperedBody = Buffer.from(JSON.stringify({ hello: "tampered" }));
    expect(verifyMetaSignature(tamperedBody, signature, appSecret)).toBe("invalid");
  });
});
