import { Module } from "@nestjs/common";
import { WhatsAppWebhookController } from "./whatsapp-webhook.controller";
import { WhatsAppWebhookService } from "./whatsapp-webhook.service";
import { InstagramWebhookController } from "./instagram-webhook.controller";
import { InstagramWebhookService } from "./instagram-webhook.service";
import { EmailWebhookController } from "./email-webhook.controller";
import { EmailWebhookService } from "./email-webhook.service";
import { RazorpayWebhookController } from "./razorpay-webhook.controller";
import { RazorpayWebhookService } from "./razorpay-webhook.service";
import { QueueModule } from "../../queue/queue.module";
import { AiModule } from "../ai/ai.module";
import { ShoppingFlowModule } from "../shopping-flow/shopping-flow.module";
import { OrderModule } from "../orders/order.module";
import { PaymentsModule } from "../payments/payments.module";

@Module({
  imports: [QueueModule, AiModule, ShoppingFlowModule, OrderModule, PaymentsModule],
  controllers: [WhatsAppWebhookController, InstagramWebhookController, EmailWebhookController, RazorpayWebhookController],
  providers: [WhatsAppWebhookService, InstagramWebhookService, EmailWebhookService, RazorpayWebhookService],
})
export class WebhooksModule {}
