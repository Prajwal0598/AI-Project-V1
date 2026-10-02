import { Injectable, Logger } from "@nestjs/common";

interface CreatePlanResult { id: string }
interface CreateSubscriptionResult { id: string; shortUrl: string | null }

// Relay bills ITS OWN merchants from Relay's own Razorpay account — completely separate webhook/secret/data model
// from any per-business Razorpay account used for customer-to-merchant order payments (see
// modules/payments/razorpay.service.ts). Credentials are read via RELAY_BILLING_RAZORPAY_KEY_ID/SECRET (not the
// per-business RAZORPAY_KEY_ID/SECRET fallback) specifically so this can point at a dedicated RelayShift
// Razorpay account later (see docs/app-overview.md "Payments") without touching any code here — today, during
// the single-merchant bootstrap stage, these are deliberately set to the same physical Razorpay test account
// already connected for that one merchant's own customer payments.
const RAZORPAY_API = "https://api.razorpay.com/v1";
// an indefinite monthly SaaS subscription has no natural end — Razorpay requires either total_count or end_at,
// so this is a large-but-finite bound (100 years of monthly cycles) rather than inventing an "unlimited" option
const INDEFINITE_MONTHLY_TOTAL_COUNT = 1200;

/** Thin wrapper over Razorpay's Subscriptions REST API (https://razorpay.com/docs/api/payments/subscriptions) —
 * no SDK dependency, same raw-fetch style as the existing per-merchant RazorpayService. Never persists
 * anything itself; SubscriptionService owns all Relay-side state. */
@Injectable()
export class RazorpayBillingProvider {
  private readonly logger = new Logger(RazorpayBillingProvider.name);

  private keyId(): string | undefined {
    return process.env.RELAY_BILLING_RAZORPAY_KEY_ID?.trim();
  }

  private authHeader(): string {
    const keyId = this.keyId();
    const keySecret = process.env.RELAY_BILLING_RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret) throw new Error("RELAY_BILLING_RAZORPAY_KEY_ID / RELAY_BILLING_RAZORPAY_KEY_SECRET are not configured — Relay's own billing account credentials are required.");
    return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  /** The public key ID (safe to send to the browser) the frontend needs to open Razorpay Checkout for a subscription. */
  getPublicKeyId(): string | undefined {
    return this.keyId();
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${RAZORPAY_API}${path}`, {
      method,
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      this.logger.error(`Razorpay billing API ${method} ${path} failed: ${JSON.stringify(errBody)}`);
      throw new Error(`Razorpay billing API request failed: ${JSON.stringify(errBody)}`);
    }
    return res.json() as Promise<T>;
  }

  /** Creates the Razorpay Plan backing a SubscriptionPlan — called lazily once per plan, result persisted as razorpayPlanId. */
  async createPlan(plan: { name: string; amount: number; currency: string; billingInterval: string }): Promise<string> {
    const result = await this.request<CreatePlanResult>("/plans", "POST", {
      period: plan.billingInterval,
      interval: 1,
      item: { name: plan.name, amount: plan.amount, currency: plan.currency },
    });
    return result.id;
  }

  /** Creates the actual recurring subscription. `startAt` delays the first real charge (used for trials) — the
   * authorisation step still happens immediately via Checkout. */
  async createSubscription(opts: { razorpayPlanId: string; businessId: string; startAt?: Date }): Promise<CreateSubscriptionResult> {
    const result = await this.request<{ id: string; short_url: string | null }>("/subscriptions", "POST", {
      plan_id: opts.razorpayPlanId,
      total_count: INDEFINITE_MONTHLY_TOTAL_COUNT,
      customer_notify: true,
      ...(opts.startAt ? { start_at: Math.floor(opts.startAt.getTime() / 1000) } : {}),
      notes: { businessId: opts.businessId },
    });
    return { id: result.id, shortUrl: result.short_url };
  }

  /** cancelAtCycleEnd=false means cancel immediately — used by the deferred-cancellation sweep once the period has already ended. */
  async cancelSubscription(providerSubscriptionId: string, cancelAtCycleEnd: boolean): Promise<void> {
    await this.request(`/subscriptions/${providerSubscriptionId}/cancel`, "POST", { cancel_at_cycle_end: cancelAtCycleEnd });
  }
}
