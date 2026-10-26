import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import { META_GRAPH_BASE_URL } from "../../../common/meta-graph";

const GRAPH_API_BASE = META_GRAPH_BASE_URL;

export interface PhoneNumberDetails {
  displayPhoneNumber: string;
  verifiedName: string | null;
}

/**
 * Thin wrapper around the server-to-server Meta Graph API calls Embedded Signup needs. Deliberately separate
 * from ConversationService's message-sending Graph API calls (which use the per-business resolved token for
 * ongoing messaging) — this service only runs during the one-off onboarding handshake, using the App
 * ID/Secret (META_APP_ID/WHATSAPP_APP_SECRET) rather than a business's own token, since the business doesn't
 * have one yet at this point. Every method throws a ServiceUnavailableException with a safe (no token/secret)
 * message on failure — callers decide how that maps onto the connection state machine.
 */
@Injectable()
export class MetaGraphApiService {
  private readonly logger = new Logger(MetaGraphApiService.name);

  private appCredentials(): { appId: string; appSecret: string } {
    const appId = process.env.META_APP_ID?.trim();
    const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException("META_APP_ID / WHATSAPP_APP_SECRET are not configured on the server.");
    }
    return { appId, appSecret };
  }

  /** Exchanges the short-lived authorization "code" the Embedded Signup JS SDK returned for a long-lived
   * System User access token. Never logs the code or the resulting token. */
  async exchangeCodeForToken(code: string): Promise<string> {
    const { appId, appSecret } = this.appCredentials();
    const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
    let res: Response;
    try {
      res = await fetch(`${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`);
    } catch (err) {
      this.logger.error("Meta code-exchange request failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Could not reach Meta to complete WhatsApp onboarding.");
    }
    if (!res.ok) {
      this.logger.error(`Meta code-exchange rejected the request (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Meta rejected the WhatsApp onboarding authorization — it may have expired. Please try connecting again.");
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new ServiceUnavailableException("Meta did not return an access token for this onboarding attempt.");
    return body.access_token;
  }

  /** Subscribes this app to the merchant's WhatsApp Business Account so inbound webhook events are delivered. */
  async subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${GRAPH_API_BASE}/${wabaId}/subscribed_apps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      this.logger.error("WABA webhook subscription request failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Could not subscribe to WhatsApp webhook events for this account.");
    }
    if (!res.ok) {
      this.logger.error(`WABA webhook subscription rejected (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Meta rejected the WhatsApp webhook subscription request.");
    }
  }

  /** Completes phone registration (required once per phone number before it can send/receive via the Cloud
   * API) — a random PIN is generated since Relay never asks the merchant for one; it's only ever needed again
   * if Meta requires re-registration, which is handled as a RETRY_REQUIRED reconnect, not a stored secret. */
  async registerPhoneNumber(phoneNumberId: string, accessToken: string): Promise<void> {
    const pin = randomInt(100_000, 999_999).toString();
    let res: Response;
    try {
      res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/register`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      });
    } catch (err) {
      this.logger.error("Phone number registration request failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Could not complete phone number setup with Meta.");
    }
    if (!res.ok) {
      this.logger.error(`Phone number registration rejected (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Meta rejected phone number registration for this WhatsApp number.");
    }
  }

  /** Fetches the real display phone number/verified business name for the connected number, used to show the
   * merchant a truthful "Connected" card instead of just echoing back the raw ID they don't recognize. */
  async getPhoneNumberDetails(phoneNumberId: string, accessToken: string): Promise<PhoneNumberDetails> {
    let res: Response;
    try {
      res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      this.logger.error("Phone number lookup request failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Could not verify the connected WhatsApp number with Meta.");
    }
    if (!res.ok) {
      this.logger.error(`Phone number lookup rejected (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Meta could not confirm the connected WhatsApp number.");
    }
    const body = (await res.json()) as { display_phone_number?: string; verified_name?: string };
    if (!body.display_phone_number) throw new ServiceUnavailableException("Meta did not return a phone number for this connection.");
    return { displayPhoneNumber: body.display_phone_number, verifiedName: body.verified_name ?? null };
  }

  /** Asks Meta who a token belongs to: GET /me?fields=id,client_business_id. For the business token Embedded Signup returns, `id`
   * is the app-scoped id of the business's system user — documented in "Facebook Login for Business > Get a client business ID".
   * Meta answers this itself, so unlike anything the browser sends it can be trusted. */
  async getTokenIdentity(accessToken: string): Promise<{ id: string; clientBusinessId: string | null }> {
    let res: Response;
    try {
      res = await fetch(`${GRAPH_API_BASE}/me?fields=id,client_business_id`, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (err) {
      this.logger.error("Token identity lookup failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Could not reach Meta to identify the connection.");
    }
    if (!res.ok) {
      this.logger.error(`Token identity lookup rejected (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Meta could not identify this connection.");
    }
    const body = (await res.json()) as { id?: string; client_business_id?: string };
    if (!body.id) throw new ServiceUnavailableException("Meta did not return an identity for this connection.");
    return { id: body.id, clientBusinessId: body.client_business_id ?? null };
  }

  /** GET /debug_token, signed with the app's own access token (app id|app secret). Never trust an access token just because the
   * browser sent it — Meta's guidance is to check which app issued it and whose it is. Never logs the token or the secret. */
  async debugToken(inputToken: string): Promise<{ appId: string | null; type: string | null; userId: string | null; isValid: boolean }> {
    const { appId, appSecret } = this.appCredentials();
    const params = new URLSearchParams({ input_token: inputToken, access_token: `${appId}|${appSecret}` });
    let res: Response;
    try {
      res = await fetch(`${GRAPH_API_BASE}/debug_token?${params.toString()}`);
    } catch (err) {
      // the request URL carries the app secret, so log the error class only — never the stack or message
      this.logger.error(`Token inspection request failed (${err instanceof Error ? err.name : "UnknownError"})`);
      throw new ServiceUnavailableException("Could not reach Meta to verify the Facebook login.");
    }
    if (!res.ok) {
      this.logger.error(`Token inspection rejected (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Meta could not verify the Facebook login.");
    }
    const body = (await res.json()) as { data?: { app_id?: string; type?: string; user_id?: string; is_valid?: boolean } };
    const data = body.data ?? {};
    return { appId: data.app_id ?? null, type: data.type ?? null, userId: data.user_id ?? null, isValid: data.is_valid === true };
  }

  /** Best-effort revocation on disconnect — never blocks the local disconnect if Meta's side fails, since the
   * merchant's intent (stop using this connection) must always succeed locally regardless. The timeout keeps a slow
   * Meta from stalling callers (the deauthorization callback answers Meta while this runs). */
  async deauthorize(wabaId: string, accessToken: string): Promise<void> {
    try {
      await fetch(`${GRAPH_API_BASE}/${wabaId}/subscribed_apps`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(4000),
      });
    } catch (err) {
      this.logger.warn(`Meta deauthorization call failed during disconnect (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
