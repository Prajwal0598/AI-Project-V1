import { prisma } from "../prisma";
import { captureException } from "../error-reporting";

// an indefinite monthly SaaS subscription has no natural end — mirrors RazorpayBillingProvider's bound on the API side
const RAZORPAY_API = "https://api.razorpay.com/v1";

async function cancelRazorpaySubscription(providerSubscriptionId: string): Promise<void> {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured");
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  const res = await fetch(`${RAZORPAY_API}/subscriptions/${providerSubscriptionId}/cancel`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ cancel_at_cycle_end: false }), // the period already ended by the time this sweep runs — cancel immediately
  });
  if (!res.ok) throw new Error(`Razorpay subscription cancel rejected (HTTP ${res.status})`);
}

/**
 * Daily billing maintenance sweep — the Relay-side counterpart to the Razorpay webhook, for the two cases
 * nothing from Razorpay ever tells us about on its own:
 * 1. A merchant clicked Cancel (cancelAtPeriodEnd=true) and their already-paid-for period has now genuinely
 *    ended — only now do we actually call Razorpay to cancel (see SubscriptionService.cancel for why this is
 *    deferred: it's what makes Resume a zero-Razorpay-API-call operation).
 * 2. A trial's end date passed with no webhook ever confirming activation (e.g. the merchant never completed
 *    card authorisation) — expire it rather than leaving paid-feature access open indefinitely.
 */
export async function processBillingSweep() {
  const now = new Date();

  const dueForCancellation = await prisma.subscription.findMany({
    where: { cancelAtPeriodEnd: true, currentPeriodEnd: { lte: now }, status: { not: "CANCELLED" } },
  });
  let cancelled = 0;
  for (const subscription of dueForCancellation) {
    try {
      if (subscription.providerSubscriptionId) await cancelRazorpaySubscription(subscription.providerSubscriptionId);
      await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "CANCELLED", cancelledAt: now } });
      cancelled += 1;
    } catch (err) {
      console.error(`[billing-sweep] failed to finalize cancellation for business ${subscription.businessId}`, err);
      captureException(err, { businessId: subscription.businessId, subscriptionId: subscription.id });
    }
  }

  const staleTrials = await prisma.subscription.updateMany({
    where: { status: "TRIAL", trialEnd: { lt: now } },
    data: { status: "EXPIRED" },
  });

  return { cancelled, expiredTrials: staleTrials.count };
}
