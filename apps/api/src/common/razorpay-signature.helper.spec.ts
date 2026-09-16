import { createHmac } from "node:crypto";
import { verifyRazorpaySignature } from "./razorpay-signature.helper";

describe("verifyRazorpaySignature", () => {
  const webhookSecret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));

  function sign(secret: string, payload: Buffer): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  it("returns 'skipped' when no webhook secret is configured", () => {
    expect(verifyRazorpaySignature(body, sign(webhookSecret, body), undefined)).toBe("skipped");
  });

  it("returns 'valid' for a correctly signed payload", () => {
    expect(verifyRazorpaySignature(body, sign(webhookSecret, body), webhookSecret)).toBe("valid");
  });

  it("returns 'invalid' for a payload signed with the wrong secret", () => {
    expect(verifyRazorpaySignature(body, sign("wrong-secret", body), webhookSecret)).toBe("invalid");
  });

  it("returns 'invalid' when the signature header is missing", () => {
    expect(verifyRazorpaySignature(body, undefined, webhookSecret)).toBe("invalid");
  });

  it("returns 'invalid' when the raw body is missing", () => {
    expect(verifyRazorpaySignature(undefined, sign(webhookSecret, body), webhookSecret)).toBe("invalid");
  });

  it("returns 'invalid' if the body was tampered with after signing", () => {
    const signature = sign(webhookSecret, body);
    const tamperedBody = Buffer.from(JSON.stringify({ event: "payment_link.cancelled" }));
    expect(verifyRazorpaySignature(tamperedBody, signature, webhookSecret)).toBe("invalid");
  });
});
