import { Module } from "@nestjs/common";
import { AiModelRouterService } from "./ai-model-router.service";

// split out of AiModule so ShoppingIntelligenceModule can reuse the same router without a module cycle
// (AiModule -> AssistedBuyingModule -> ShoppingIntelligenceModule -> AiModelRouterModule)
@Module({ providers: [AiModelRouterService], exports: [AiModelRouterService] })
export class AiModelRouterModule {}
