import { Injectable, Logger } from "@nestjs/common";
import type { Business, Order } from "@prisma/client";
import { decryptSecret } from "../../common/crypto.helper";
import { verifyRazorpaySignature } from "../../common/razorpay-signature.helper";

interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

interface PaymentLinkResult {
  id: string;
  shortUrl: string;
}

/**
 * Wraps Razorpay's Payment Links API (https://api.razorpay.com/v1/payment_links) so a customer choosing
 * UPI gets a real, payable link instead of the simulated dummy checkout URL. Falls back gracefully (returns
 * null, never throws) when a business hasn't configured Razorpay yet — callers keep working exactly as
 * before (simulated payment flow) in that case, so this is purely additive/opt-in per business.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  private resolveCredentials(business: Pick<Business, "razorpayKeyId" | "razorpayKeySecretEncrypted">): RazorpayCredentials | null {
    const keyId = business.razorpayKeyId?.trim() || process.env.RAZORPAY_KEY_ID?.trim();
    let keySecret: string | undefined;
    if (business.razorpayKeySecretEncrypted) {
      try { keySecret = decryptSecret(business.razorpayKeySecretEncrypted); } catch (err) {
        this.logger.error("Failed to decrypt Razorpay key secret — falling back to .env", err instanceof Error ? err.stack : String(err));
      }
    }
    keySecret = keySecret ?? process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret) return null;
    return { keyId, keySecret };
  }

  resolveWebhookSecret(business: Pick<Business, "razorpayWebhookSecretEncrypted">): string | undefined {
    if (business.razorpayWebhookSecretEncrypted) {
      try { return decryptSecret(business.razorpayWebhookSecretEncrypted); } catch (err) {
        this.logger.error("Failed to decrypt Razorpay webhook secret — falling back to .env", err instanceof Error ? err.stack : String(err));
      }
    }
    return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || undefined;
  }

  verifyWebhookSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined, business: Pick<Business, "razorpayWebhookSecretEncrypted">): "skipped" | "valid" | "invalid" {
    return verifyRazorpaySignature(rawBody, signatureHeader, this.resolveWebhookSecret(business));
  }

  /** Creates a real, payable Razorpay Payment Link for this order's total. Returns null (logged) if Razorpay
   * isn't configured for this business, or if the Razorpay API call fails for any reason — never throws, so
   * the caller can fall back to the existing simulated payment flow instead of failing order creation. */
  async createPaymentLink(
    business: Pick<Business, "id" | "razorpayKeyId" | "razorpayKeySecretEncrypted" | "name">,
    order: Pick<Order, "id" | "total" | "currency">,
    customer: { name: string; phone?: string | null },
  ): Promise<PaymentLinkResult | null> {
    const credentials = this.resolveCredentials(business);
    if (!credentials) return null;

    // amount must be in the smallest currency unit (paise for INR) — total is a Decimal, round to avoid float drift
    const amountInSubunits = Math.round(Number(order.total) * 100);

    try {
      const res = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountInSubunits,
          currency: order.currency || "INR",
          description: `Order #${order.id.slice(-8).toUpperCase()} — ${business.name}`,
          reference_id: order.id,
          customer: {
            name: customer.name || "Customer",
            ...(customer.phone ? { contact: customer.phone } : {}),
          },
          // we deliver the link ourselves via WhatsApp — don't let Razorpay also SMS/email the customer separately
          notify: { sms: false, email: false },
          notes: { orderId: order.id, businessId: business.id },
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        this.logger.error(`Razorpay payment link creation failed for order ${order.id}: ${JSON.stringify(errBody)}`);
        return null;
      }

      const data = await res.json() as { id: string; short_url: string };
      return { id: data.id, shortUrl: data.short_url };
    } catch (err) {
      this.logger.error(`Razorpay payment link request failed for order ${order.id}`, err instanceof Error ? err.stack : String(err));
      return null;
    }
  }
}
