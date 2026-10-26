import { isCredentialEncryptionConfigured } from "../../../common/crypto.helper";

export interface MetaAppConfig {
  /** Public Meta App ID — safe to show; it is also baked into the web bundle as NEXT_PUBLIC_META_APP_ID. */
  appId: string | null;
  /** Never leaves the server. Signs/verifies every Meta request, so it must belong to the same app as appId. */
  appSecret: string | null;
  /** Names (never values) of server variables that Embedded Signup and the Meta callbacks cannot work without. */
  missing: string[];
}

/** The API side of the Meta app configuration; the web side (NEXT_PUBLIC_*) is checked in the browser. */
export function readMetaAppConfig(): MetaAppConfig {
  const appId = process.env.META_APP_ID?.trim() || null;
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim() || null;
  const missing: string[] = [];
  if (!appId) missing.push("META_APP_ID");
  if (!appSecret) missing.push("WHATSAPP_APP_SECRET");
  if (!isCredentialEncryptionConfigured()) missing.push("CREDENTIALS_ENCRYPTION_KEY");
  return { appId, appSecret, missing };
}

/**
 * Meta's callbacks name a person by an app-scoped id, and nobody has yet seen a real callback carry the same id this server
 * stored when the merchant connected. Until an operator sets META_CALLBACK_IDENTITY_MATCH_VERIFIED=true after observing that,
 * a match is a hypothesis: it is recorded for a platform admin to review and nothing is disconnected or deleted automatically.
 */
export function isCallbackIdentityMatchVerified(): boolean {
  return process.env.META_CALLBACK_IDENTITY_MATCH_VERIFIED === "true";
}
