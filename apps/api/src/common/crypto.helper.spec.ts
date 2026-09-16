import { encryptSecret, decryptSecret, isCredentialEncryptionConfigured } from "./crypto.helper";

describe("crypto.helper", () => {
  const ORIGINAL_ENV = process.env.CREDENTIALS_ENCRYPTION_KEY;
  const VALID_KEY = "0".repeat(64); // 32 bytes hex

  afterEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = ORIGINAL_ENV;
  });

  describe("isCredentialEncryptionConfigured", () => {
    it("returns false when the env var is unset", () => {
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      expect(isCredentialEncryptionConfigured()).toBe(false);
    });

    it("returns false when the key is not 32 bytes (64 hex chars)", () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY = "abcd";
      expect(isCredentialEncryptionConfigured()).toBe(false);
    });

    it("returns true for a valid 64-char hex key", () => {
      process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
      expect(isCredentialEncryptionConfigured()).toBe(true);
    });
  });

  describe("encryptSecret / decryptSecret", () => {
    beforeEach(() => {
      process.env.CREDENTIALS_ENCRYPTION_KEY = VALID_KEY;
    });

    it("round-trips a plaintext secret", () => {
      const plaintext = "EAAG_some_whatsapp_access_token_value";
      const encrypted = encryptSecret(plaintext);
      expect(decryptSecret(encrypted)).toBe(plaintext);
    });

    it("produces a different ciphertext each time (random IV)", () => {
      const plaintext = "same-secret";
      const a = encryptSecret(plaintext);
      const b = encryptSecret(plaintext);
      expect(a).not.toBe(b);
      expect(decryptSecret(a)).toBe(plaintext);
      expect(decryptSecret(b)).toBe(plaintext);
    });

    it("throws when the encryption key isn't configured", () => {
      delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      expect(() => encryptSecret("x")).toThrow();
    });

    it("throws when decrypting a malformed stored value", () => {
      expect(() => decryptSecret("not-the-right-format")).toThrow();
    });

    it("throws when decrypting with a tampered auth tag (detects corruption)", () => {
      const encrypted = encryptSecret("secret-value");
      const [iv, tag, data] = encrypted.split(":");
      const tamperedTag = "0".repeat(tag.length);
      expect(() => decryptSecret(`${iv}:${tamperedTag}:${data}`)).toThrow();
    });
  });
});
