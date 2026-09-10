import { createDecipheriv } from "node:crypto";

// mirrors apps/api's crypto.helper.ts decrypt half — duplicated because the worker is a separate process
function getKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "hex");
  return key.length === 32 ? key : null;
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

/** Prefers the merchant's own encrypted credential; falls back to the shared .env token (single-demo-business setup). */
export function resolveToken(encrypted: string | null | undefined, envVar: string): string | undefined {
  if (encrypted) {
    try { return decryptSecret(encrypted); } catch (err) { console.error(`[channel-send] failed to decrypt credential, falling back to .env: ${envVar}`, err); }
  }
  return process.env[envVar];
}
