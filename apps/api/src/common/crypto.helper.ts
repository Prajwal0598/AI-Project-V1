import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM: random IV per encryption, auth tag appended, all hex-encoded as "iv:authTag:ciphertext".
// Used to store per-merchant channel credentials (WhatsApp/Instagram/Postmark tokens) at rest, distinct
// from the single shared .env tokens used for the one demo business — never sent to the AI or the frontend.

function getKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) return null; // must be a 32-byte (64 hex char) key for AES-256
  return key;
}

export function isCredentialEncryptionConfigured(): boolean {
  return getKey() !== null;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured (must be a 64-char hex string).");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const key = getKey();
  if (!key) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured (must be a 64-char hex string).");
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted credential.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
