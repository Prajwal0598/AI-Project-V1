import { prisma } from "../prisma";
import { encryptSecret, decryptSecret } from "../crypto.helper";
import { captureException } from "../error-reporting";

const AUTH_BASE = "https://auth.razorpay.com";
// refresh proactively well before the 90-day access_token / 180-day refresh_token expiry, so a transient
// Razorpay outage on any given day doesn't strand a merchant mid-window
const REFRESH_WINDOW_DAYS = 14;

interface RazorpayTokenResponse {
  access_token?: string;
  refresh_token?: string;
  public_token?: string;
  expires_in?: number;
}

/**
 * Stopgap-adjacent, but not a stopgap itself: Razorpay OAuth (Technology Partner) access tokens expire every
 * 90 days and must be refreshed with the refresh_token before then, or every payment-link API call for that
 * business starts failing with a 401 until the merchant reconnects manually. Runs daily; refreshes any
 * business whose token is within REFRESH_WINDOW_DAYS of expiring. One business's failure never blocks
 * another's — each is refreshed independently and only marked RETRY_REQUIRED on its own failure.
 */
export async function processRazorpayTokenRefresh() {
  const clientId = process.env.RAZORPAY_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.RAZORPAY_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { skipped: "RAZORPAY_OAUTH_CLIENT_ID/SECRET not configured" };

  const cutoff = new Date(Date.now() + REFRESH_WINDOW_DAYS * 86_400_000);
  const businesses = await prisma.business.findMany({
    where: { razorpayConnectionStatus: "CONNECTED", razorpayRefreshTokenEncrypted: { not: null }, razorpayTokenExpiresAt: { lte: cutoff } },
    select: { id: true, razorpayRefreshTokenEncrypted: true },
  });

  let refreshed = 0;
  const failed: string[] = [];

  for (const business of businesses) {
    try {
      const refreshToken = decryptSecret(business.razorpayRefreshTokenEncrypted!);
      const res = await fetch(`${AUTH_BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      if (!res.ok) throw new Error(`Razorpay token refresh rejected (HTTP ${res.status})`);
      const data = (await res.json()) as RazorpayTokenResponse;
      if (!data.access_token || !data.refresh_token || !data.public_token || !data.expires_in) {
        throw new Error("Razorpay did not return a complete token set for this refresh");
      }

      await prisma.business.update({
        where: { id: business.id },
        data: {
          razorpayAccessTokenEncrypted: encryptSecret(data.access_token),
          razorpayRefreshTokenEncrypted: encryptSecret(data.refresh_token),
          razorpayPublicToken: data.public_token,
          razorpayTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
          razorpayLastErrorMessage: null,
        },
      });
      refreshed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Razorpay token refresh failed";
      console.error(`[razorpay-token-refresh] business ${business.id} failed: ${message}`);
      captureException(err, { businessId: business.id, job: "razorpay-token-refresh" });
      await prisma.business.update({
        where: { id: business.id },
        data: { razorpayConnectionStatus: "RETRY_REQUIRED", razorpayLastErrorMessage: message },
      }).catch((updateErr) => console.error(`[razorpay-token-refresh] also failed to record the failure for business ${business.id}`, updateErr));
      failed.push(business.id);
    }
  }

  return { checked: businesses.length, refreshed, failed };
}
