import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
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
import { UserModule } from "./modules/users/user.module";
import { ImportModule } from "./modules/imports/import.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { QueueModule } from "./queue/queue.module";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]), // default: 100 req/min per IP across the API
    DatabaseModule, AuthModule, BusinessModule, CustomerModule, ConversationModule, AiModule, ProductModule, OrderModule, UserModule, ImportModule, WebhooksModule, QueueModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
