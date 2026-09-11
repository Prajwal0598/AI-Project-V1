import { Module } from "@nestjs/common";
import { ShoppingFlowService } from "./shopping-flow.service";
import { ConversationModule } from "../conversations/conversation.module";
import { CartModule } from "../cart/cart.module";
import { OrderModule } from "../orders/order.module";

@Module({
  imports: [ConversationModule, CartModule, OrderModule],
  providers: [ShoppingFlowService],
  exports: [ShoppingFlowService],
})
export class ShoppingFlowModule {}
