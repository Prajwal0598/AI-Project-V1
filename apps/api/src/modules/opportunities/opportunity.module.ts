import { Module } from "@nestjs/common";
import { OpportunityController } from "./opportunity.controller";
import { OpportunityService } from "./opportunity.service";
import { SuggestionAiService } from "./suggestion-ai.service";
import { ConversationModule } from "../conversations/conversation.module";
import { CustomerSignalModule } from "../customer-signals/customer-signal.module";

@Module({
  imports: [ConversationModule, CustomerSignalModule],
  controllers: [OpportunityController],
  providers: [OpportunityService, SuggestionAiService],
  exports: [OpportunityService, SuggestionAiService],
})
export class OpportunityModule {}
