import { Module } from "@nestjs/common";
import { WhatsAppEmbeddedSignupController } from "./whatsapp-embedded-signup.controller";
import { WhatsAppEmbeddedSignupService } from "./whatsapp-embedded-signup.service";
import { MetaGraphApiService } from "./meta-graph-api.service";

@Module({
  controllers: [WhatsAppEmbeddedSignupController],
  providers: [WhatsAppEmbeddedSignupService, MetaGraphApiService],
})
export class WhatsAppEmbeddedSignupModule {}
