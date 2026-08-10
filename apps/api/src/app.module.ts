import { Module } from "@nestjs/common";
import { BusinessModule } from "./modules/businesses/business.module";
import { AiModule } from "./modules/ai/ai.module";
import { ConversationModule } from "./modules/conversations/conversation.module";
import { CustomerModule } from "./modules/customers/customer.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./common/health.controller";

@Module({
  imports: [DatabaseModule, BusinessModule, CustomerModule, ConversationModule, AiModule],
  controllers: [HealthController]
})
export class AppModule {}
