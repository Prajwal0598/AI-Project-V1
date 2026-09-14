import { Module } from "@nestjs/common";
import { PromotionController } from "./promotion.controller";
import { PromotionService } from "./promotion.service";
import { OpportunityModule } from "../opportunities/opportunity.module";

@Module({
  imports: [OpportunityModule],
  controllers: [PromotionController],
  providers: [PromotionService],
})
export class PromotionModule {}
