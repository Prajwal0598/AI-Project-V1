import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { RazorpayService } from "../payments/razorpay.service";
import { OrderService } from "../orders/order.service";
import { captureException } from "../../common/error-reporting.helper";

// Only the fields of Razorpay's documented payment_link.paid payload that are used here. Amounts are integers in the
// currency's smallest unit (paise for INR); `payment` is the captured payment, `payment_link` the link it paid.
export interface RazorpayWebhookPayload {
  event: string;
  payload?: {
    payment_link?: { entity?: { id?: string; reference_id?: string | null; amount_paid?: number } };
    payment?: { entity?: { id?: string; amount?: number; currency?: string } };
  };
}

/** The amount actually paid, read from the payment entity — null when it is missing or malformed (so it is never guessed). */
function readPaidAmount(body: RazorpayWebhookPayload): { amountMinor: number; currency: string } | null {
  const amount = body.payload?.payment?.entity?.amount;
  const currency = body.payload?.payment?.entity?.currency;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return null;
  // our payment links never accept partial payments, so when the link reports its own paid total it must equal this payment
  const linkPaid = body.payload?.payment_link?.entity?.amount_paid;
  if (linkPaid !== undefined && linkPaid !== amount) return null;
  return { amountMinor: amount, currency: currency.toUpperCase() };
}

@Injectable()
export class RazorpayWebhookService {
  private readonly logger = new Logger(RazorpayWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly orders: OrderService,
  ) {}

  async ingest(businessId: string, body: RazorpayWebhookPayload): Promise<void> {
    if (body.event !== "payment_link.paid") {
      this.logger.log(`Ignoring Razorpay webhook event "${body.event}" for business ${businessId} — only payment_link.paid is handled.`);
      return;
    }

    const paymentLinkId = body.payload?.payment_link?.entity?.id;
    const paymentId = body.payload?.payment?.entity?.id;
    if (!paymentLinkId || !paymentId) {
      this.logger.warn(`Razorpay payment_link.paid webhook missing expected ids for business ${businessId}`);
      return;
    }

    const order = await this.prisma.order.findFirst({ where: { razorpayPaymentLinkId: paymentLinkId, businessId } });
    if (!order) {
      this.logger.warn(`No order found for Razorpay payment link ${paymentLinkId} (business ${businessId})`);
      return;
    }

    // the link was created with reference_id = our order id; a different one means this payload is not for this order
    const reference = body.payload?.payment_link?.entity?.reference_id;
    if (typeof reference === "string" && reference !== order.id) {
      this.logger.warn(`Razorpay payment ${paymentId} ignored: link ${paymentLinkId} references another order than ${order.id}`);
      return;
    }

    const paid = readPaidAmount(body);
    if (!paid) {
      this.logger.warn(`Razorpay payment ${paymentId} for order ${order.id} ignored: the paid amount or currency is missing or malformed`);
      captureException(new Error("Razorpay paid webhook without a verifiable amount"), { orderId: order.id, businessId, paymentId });
      return;
    }

    const result = await this.orders.markPaidViaRazorpay(order.id, businessId, paymentId, paid);
    if (!("skipped" in result)) {
      this.logger.log(`Order ${order.id} marked PAID via Razorpay payment ${paymentId}`);
      return;
    }
    if ("expectedMinor" in result) {
      // money arrived that does not match the order — never confirm it automatically; the merchant has to look at it
      this.logger.warn(`Razorpay payment ${paymentId} for order ${order.id} NOT applied: paid ${result.paidMinor} ${result.paidCurrency}, order expects ${result.expectedMinor} ${result.expectedCurrency} (minor units)`);
      captureException(new Error("Razorpay payment does not match the order"), { orderId: order.id, businessId, paymentId, expectedMinor: result.expectedMinor, paidMinor: result.paidMinor });
      return;
    }
    this.logger.log(`Razorpay payment for order ${order.id} skipped: ${result.skipped}`);
  }
}
