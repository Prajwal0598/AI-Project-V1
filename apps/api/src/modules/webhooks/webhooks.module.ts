import { Module } from "@nestjs/common";
import { WhatsAppWebhookController } from "./whatsapp-webhook.controller";
import { WhatsAppWebhookService } from "./whatsapp-webhook.service";

@Module({ controllers: [WhatsAppWebhookController], providers: [WhatsAppWebhookService] })
export class WebhooksModule {}
