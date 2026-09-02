import { Body, Controller, ForbiddenException, HttpCode, Post, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { EmailWebhookService } from "./email-webhook.service";

@Public()
@Controller("webhooks/email")
export class EmailWebhookController {
  constructor(private readonly email: EmailWebhookService) {}

  // Postmark (and most inbound email providers) have no handshake step like Meta;
  // a shared secret query param on the webhook URL is the standard lightweight check.
  @Post()
  @HttpCode(200)
  receive(@Body() body: unknown, @Query("secret") secret?: string) {
    const expected = process.env.EMAIL_WEBHOOK_SECRET;
    if (expected && secret !== expected) throw new ForbiddenException("Invalid webhook secret.");
    void this.email.ingest(body);
    return "OK";
  }
}
