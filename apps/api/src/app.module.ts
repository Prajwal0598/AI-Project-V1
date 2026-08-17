import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { BusinessModule } from "./modules/businesses/business.module";
import { AiModule } from "./modules/ai/ai.module";
import { ConversationModule } from "./modules/conversations/conversation.module";
import { CustomerModule } from "./modules/customers/customer.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./common/health.controller";
import { AuthModule } from "./modules/auth/auth.module";
import { JwtAuthGuard } from "./modules/auth/jwt-auth.guard";
import { ProductModule } from "./modules/products/product.module";
import { OrderModule } from "./modules/orders/order.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";

@Module({
  imports: [DatabaseModule, AuthModule, BusinessModule, CustomerModule, ConversationModule, AiModule, ProductModule, OrderModule, WebhooksModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
