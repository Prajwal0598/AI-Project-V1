import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";

const AUTH_BASE = "https://auth.razorpay.com";

export interface RazorpayTokenSet {
  accessToken: string;
  refreshToken: string;
  publicToken: string;
  expiresInSeconds: number;
  /** only present on the initial authorization_code exchange, not on a refresh */
  razorpayAccountId?: string;
}

/**
 * Thin wrapper around Razorpay's Partner OAuth endpoints (https://razorpay.com/docs/partners/technology-partners/onboard-businesses/integrate-oauth/).
 * Requires Relay to be approved as a Razorpay Technology Partner first — RAZORPAY_OAUTH_CLIENT_ID/SECRET come
 * from a Partner Application created on the Razorpay Partner Dashboard, not a regular merchant account. Every
 * method throws a ServiceUnavailableException with a safe (no token/secret) message on failure, same pattern
 * as MetaGraphApiService — callers decide how that maps onto the connection state machine.
 */
@Injectable()
export class RazorpayOAuthApiService {
  private readonly logger = new Logger(RazorpayOAuthApiService.name);

  private partnerCredentials(): { clientId: string; clientSecret: string } {
    const clientId = process.env.RAZORPAY_OAUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.RAZORPAY_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException("RAZORPAY_OAUTH_CLIENT_ID / RAZORPAY_OAUTH_CLIENT_SECRET are not configured on the server.");
    }
    return { clientId, clientSecret };
  }

  /** Builds the URL the merchant's browser is redirected to in order to authorize Relay's access to their
   * Razorpay account. `state` must be a value only this server could have generated (see RazorpayOAuthService). */
  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const { clientId } = this.partnerCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "read_write",
      state,
    });
    return `${AUTH_BASE}/authorize?${params.toString()}`;
  }

  private async requestToken(body: Record<string, string>): Promise<RazorpayTokenSet> {
    const { clientId, clientSecret } = this.partnerCredentials();
    let res: Response;
    try {
      res = await fetch(`${AUTH_BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...body }),
      });
    } catch (err) {
      this.logger.error("Razorpay OAuth token request failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Could not reach Razorpay to complete the connection.");
    }
    if (!res.ok) {
      this.logger.error(`Razorpay OAuth token request rejected (HTTP ${res.status})`);
      throw new ServiceUnavailableException("Razorpay rejected the connection request — it may have expired. Please try connecting again.");
    }
    const data = (await res.json()) as {
      access_token?: string; refresh_token?: string; public_token?: string; expires_in?: number; razorpay_account_id?: string;
    };
    if (!data.access_token || !data.refresh_token || !data.public_token || !data.expires_in) {
      throw new ServiceUnavailableException("Razorpay did not return a complete token set for this connection attempt.");
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      publicToken: data.public_token,
      expiresInSeconds: data.expires_in,
      razorpayAccountId: data.razorpay_account_id,
    };
  }

  /** Exchanges the authorization `code` from the redirect callback for the initial token set. */
  exchangeCodeForToken(code: string, redirectUri: string): Promise<RazorpayTokenSet> {
    return this.requestToken({ grant_type: "authorization_code", redirect_uri: redirectUri, code });
  }

  /** access_token expires every 90 days, refresh_token every 180 — must be refreshed before either expires
   * (see apps/worker/src/jobs/razorpay-token-refresh.ts) or API calls start failing with a 4xx. */
  refreshAccessToken(refreshToken: string): Promise<RazorpayTokenSet> {
    return this.requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** Best-effort revocation on disconnect — never blocks the local disconnect if Razorpay's side fails. */
  async revokeToken(token: string, tokenTypeHint: "access_token" | "refresh_token"): Promise<void> {
    const { clientId, clientSecret } = this.partnerCredentials();
    try {
      await fetch(`${AUTH_BASE}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, token_type_hint: tokenTypeHint, token }),
      });
    } catch (err) {
      this.logger.warn(`Razorpay token revocation call failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
