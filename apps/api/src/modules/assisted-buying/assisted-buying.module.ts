import { Module } from "@nestjs/common";
import { AssistedBuyingService } from "./assisted-buying.service";
import { ConversationModule } from "../conversations/conversation.module";
import { CartModule } from "../cart/cart.module";

@Module({
  imports: [ConversationModule, CartModule],
  providers: [AssistedBuyingService],
  exports: [AssistedBuyingService],
})
export class AssistedBuyingModule {}
