import { Module } from "@nestjs/common";
import { WhatsAppWebhookController } from "./whatsapp-webhook.controller";
import { WhatsAppWebhookService } from "./whatsapp-webhook.service";
import { InstagramWebhookController } from "./instagram-webhook.controller";
import { InstagramWebhookService } from "./instagram-webhook.service";
import { EmailWebhookController } from "./email-webhook.controller";
import { EmailWebhookService } from "./email-webhook.service";
import { QueueModule } from "../../queue/queue.module";
import { AiModule } from "../ai/ai.module";
import { ShoppingFlowModule } from "../shopping-flow/shopping-flow.module";

@Module({
  imports: [QueueModule, AiModule, ShoppingFlowModule],
  controllers: [WhatsAppWebhookController, InstagramWebhookController, EmailWebhookController],
  providers: [WhatsAppWebhookService, InstagramWebhookService, EmailWebhookService],
})
export class WebhooksModule {}
