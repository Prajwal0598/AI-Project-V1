import { Module } from "@nestjs/common";
import { ShoppingFlowService } from "./shopping-flow.service";
import { ConversationModule } from "../conversations/conversation.module";
import { CartModule } from "../cart/cart.module";
import { OrderModule } from "../orders/order.module";
import { CustomerSignalModule } from "../customer-signals/customer-signal.module";
import { ShoppingIntelligenceModule } from "../shopping-intelligence/shopping-intelligence.module";

@Module({
  imports: [ConversationModule, CartModule, OrderModule, CustomerSignalModule, ShoppingIntelligenceModule],
  providers: [ShoppingFlowService],
  exports: [ShoppingFlowService],
})
export class ShoppingFlowModule {}
