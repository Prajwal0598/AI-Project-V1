import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";
import { RazorpayService } from "../payments/razorpay.service";
import { OrderService } from "../orders/order.service";

export interface RazorpayWebhookPayload {
  event: string;
  payload?: {
    payment_link?: { entity?: { id?: string } };
    payment?: { entity?: { id?: string } };
  };
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

    const result = await this.orders.markPaidViaRazorpay(order.id, businessId, paymentId);
    if ("skipped" in result) this.logger.log(`Razorpay payment for order ${order.id} skipped: ${result.skipped}`);
    else this.logger.log(`Order ${order.id} marked PAID via Razorpay payment ${paymentId}`);
  }
}
