import { Module } from "@nestjs/common";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { OrderModule } from "../orders/order.module";
import { ConversationModule } from "../conversations/conversation.module";
import { CartModule } from "../cart/cart.module";
import { CustomerSignalModule } from "../customer-signals/customer-signal.module";
import { OpportunityModule } from "../opportunities/opportunity.module";
import { AssistedBuyingModule } from "../assisted-buying/assisted-buying.module";

@Module({ imports: [OrderModule, ConversationModule, CartModule, CustomerSignalModule, OpportunityModule, AssistedBuyingModule], controllers: [AiController], providers: [AiService], exports: [AiService] })
export class AiModule {}
