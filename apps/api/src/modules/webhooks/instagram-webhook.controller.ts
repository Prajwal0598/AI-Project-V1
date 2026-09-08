import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Logger, Post, Query, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/public.decorator";
import { verifyMetaSignature } from "../../common/meta-signature.helper";
import { InstagramWebhookService } from "./instagram-webhook.service";

@Public()
@Controller("webhooks/instagram")
export class InstagramWebhookController {
  private readonly logger = new Logger(InstagramWebhookController.name);

  constructor(private readonly instagram: InstagramWebhookService) {}

  // Meta sends a GET with hub.* query params to verify the endpoint during setup
  @Get()
  verify(@Query() q: Record<string, string>) {
    const hub = q as { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string };
    if (hub["hub.mode"] === "subscribe" && hub["hub.verify_token"] === process.env.INSTAGRAM_VERIFY_TOKEN) {
      return hub["hub.challenge"];
    }
    throw new ForbiddenException("Webhook verification failed.");
  }

  // Meta expects a 200 response immediately; message processing happens async
  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers("x-hub-signature-256") signature: string | undefined, @Body() body: unknown) {
    const result = verifyMetaSignature(req.rawBody, signature, process.env.INSTAGRAM_APP_SECRET);
    if (result === "invalid") {
      this.logger.warn("Rejected Instagram webhook — invalid X-Hub-Signature-256.");
      throw new ForbiddenException("Invalid signature.");
    }
    if (result === "skipped") this.logger.warn("INSTAGRAM_APP_SECRET not configured — webhook signature is NOT being verified.");
    void this.instagram.ingest(body);
    return "EVENT_RECEIVED";
  }
}
