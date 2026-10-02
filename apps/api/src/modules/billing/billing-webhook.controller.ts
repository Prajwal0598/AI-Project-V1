import { Body, Controller, ForbiddenException, Headers, HttpCode, Logger, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";
import { verifyRazorpaySignature } from "../../common/razorpay-signature.helper";
import { isProduction } from "../../common/env";
import { captureException } from "../../common/error-reporting.helper";
import { BillingWebhookService, type RazorpayBillingWebhookPayload } from "./billing-webhook.service";

// Relay's merchant-to-Relay SaaS billing webhook — deliberately a separate route/controller/secret from
// webhooks/razorpay/:businessId (customer-to-merchant order payments). Never merge these two handlers: they
// belong to completely different Razorpay accounts (Relay's own vs. each business's own) and trust boundaries.
@Public()
@Controller("webhooks/razorpay/billing")
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(private readonly webhook: BillingWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Body() body: RazorpayBillingWebhookPayload & { event?: string },
  ) {
    const webhookSecret = process.env.RAZORPAY_BILLING_WEBHOOK_SECRET?.trim();
    const result = verifyRazorpaySignature(req.rawBody, signature, webhookSecret);
    if (result === "invalid") {
      this.logger.warn("Rejected Razorpay billing webhook — invalid signature.");
      throw new ForbiddenException("Invalid signature.");
    }
    if (result === "skipped") {
      if (isProduction()) {
        this.logger.error("Rejected Razorpay billing webhook — no RAZORPAY_BILLING_WEBHOOK_SECRET configured in production.");
        captureException(new Error("Razorpay billing webhook secret not configured in production"));
        throw new ForbiddenException("Webhook signature verification is not configured.");
      }
      this.logger.warn("RAZORPAY_BILLING_WEBHOOK_SECRET not configured — billing webhook signature is NOT being verified.");
    }

    // Razorpay's own event id (`x-razorpay-event-id`) isn't always present on every account config — the event
    // payload itself has no single universal id field, so we key idempotency on the header when present, else
    // fall back to a signature-derived key so re-delivery of the exact same body is still a safe no-op.
    const eventId = req.headers["x-razorpay-event-id"] as string | undefined;
    const fallbackId = `${body.event ?? "unknown"}:${signature ?? "unsigned"}`;
    await this.webhook.ingest(eventId ?? fallbackId, body as RazorpayBillingWebhookPayload);
    return { status: "ok" };
  }
}
