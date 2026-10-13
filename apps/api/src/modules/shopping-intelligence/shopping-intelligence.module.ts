import { Module } from "@nestjs/common";
import { AiModelRouterModule } from "../ai/ai-model-router.module";
import { ShoppingInterpreterService } from "./shopping-interpreter.service";

@Module({
  imports: [AiModelRouterModule],
  providers: [ShoppingInterpreterService],
  exports: [ShoppingInterpreterService],
})
export class ShoppingIntelligenceModule {}
