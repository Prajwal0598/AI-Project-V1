import { Module } from "@nestjs/common";
import { AssistedBuyingService } from "./assisted-buying.service";
import { ConversationModule } from "../conversations/conversation.module";
import { CartModule } from "../cart/cart.module";
import { ShoppingIntelligenceModule } from "../shopping-intelligence/shopping-intelligence.module";

@Module({
  imports: [ConversationModule, CartModule, ShoppingIntelligenceModule],
  providers: [AssistedBuyingService],
  exports: [AssistedBuyingService],
})
export class AssistedBuyingModule {}
