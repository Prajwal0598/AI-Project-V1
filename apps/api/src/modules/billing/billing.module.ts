import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingWebhookController } from "./billing-webhook.controller";
import { SubscriptionService } from "./subscription.service";
import { RazorpayBillingProvider } from "./razorpay-billing.provider";
import { BillingWebhookService } from "./billing-webhook.service";
import { EntitlementService } from "./entitlement.service";

@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [SubscriptionService, RazorpayBillingProvider, BillingWebhookService, EntitlementService],
  exports: [SubscriptionService, EntitlementService],
})
export class BillingModule {}
