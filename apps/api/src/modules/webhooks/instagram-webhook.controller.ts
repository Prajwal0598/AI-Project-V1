import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { InstagramWebhookService } from "./instagram-webhook.service";

@Public()
@Controller("webhooks/instagram")
export class InstagramWebhookController {
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
  receive(@Body() body: unknown) {
    void this.instagram.ingest(body);
    return "EVENT_RECEIVED";
  }
}
