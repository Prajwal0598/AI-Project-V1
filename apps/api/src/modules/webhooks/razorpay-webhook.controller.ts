import { Body, Controller, ForbiddenException, Headers, HttpCode, Logger, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../../database/prisma.service";
import { RazorpayService } from "../payments/razorpay.service";
import { RazorpayWebhookService, type RazorpayWebhookPayload } from "./razorpay-webhook.service";
import { isProduction } from "../../common/env";

// businessId is embedded in the URL path (unlike WhatsApp/Instagram, which use one shared app-level secret) —
// each business has its OWN Razorpay account/webhook secret, so we need to know which one before verifying
@Public()
@Controller("webhooks/razorpay")
export class RazorpayWebhookController {
  private readonly logger = new Logger(RazorpayWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly webhook: RazorpayWebhookService,
  ) {}

  @Post(":businessId")
  @HttpCode(200)
  async receive(
    @Param("businessId") businessId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string | undefined,
    @Body() body: RazorpayWebhookPayload,
  ) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found.");

    const result = this.razorpay.verifyWebhookSignature(req.rawBody, signature, business);
    if (result === "invalid") {
      this.logger.warn(`Rejected Razorpay webhook for business ${businessId} — invalid signature.`);
      throw new ForbiddenException("Invalid signature.");
    }
    if (result === "skipped") {
      if (isProduction()) {
        this.logger.error(`Rejected Razorpay webhook for business ${businessId} — no webhook secret configured in production.`);
        throw new ForbiddenException("Webhook signature verification is not configured.");
      }
      this.logger.warn(`Razorpay webhook secret not configured for business ${businessId} — signature is NOT being verified.`);
    }

    await this.webhook.ingest(businessId, body);
    return { status: "ok" };
  }
}
