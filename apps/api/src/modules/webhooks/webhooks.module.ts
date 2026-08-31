import { Module } from "@nestjs/common";
import { WhatsAppWebhookController } from "./whatsapp-webhook.controller";
import { WhatsAppWebhookService } from "./whatsapp-webhook.service";
import { QueueModule } from "../../queue/queue.module";

@Module({ imports: [QueueModule], controllers: [WhatsAppWebhookController], providers: [WhatsAppWebhookService] })
export class WebhooksModule {}
