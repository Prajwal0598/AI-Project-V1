import { Body, Controller, ForbiddenException, HttpCode, Logger, Post, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { isProduction } from "../../common/env";
import { EmailWebhookService } from "./email-webhook.service";

@Public()
@Controller("webhooks/email")
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(private readonly email: EmailWebhookService) {}

  // Postmark (and most inbound email providers) have no handshake step like Meta;
  // a shared secret query param on the webhook URL is the standard lightweight check.
  @Post()
  @HttpCode(200)
  receive(@Body() body: unknown, @Query("secret") secret?: string) {
    const expected = process.env.EMAIL_WEBHOOK_SECRET;
    if (expected) {
      if (secret !== expected) throw new ForbiddenException("Invalid webhook secret.");
    } else if (isProduction()) {
      this.logger.error("Rejected email webhook — EMAIL_WEBHOOK_SECRET is not configured in production.");
      throw new ForbiddenException("Webhook secret is not configured.");
    } else {
      this.logger.warn("EMAIL_WEBHOOK_SECRET not configured — webhook secret is NOT being verified.");
    }
    void this.email.ingest(body);
    return "OK";
  }
}
