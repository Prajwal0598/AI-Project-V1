import { Module } from "@nestjs/common";
import { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import { MetaCallbacksController } from "./meta-callbacks.controller";
import { MetaCallbacksService } from "./meta-callbacks.service";
import { MetaIdentityController } from "./meta-identity.controller";
import { MetaIdentityService } from "./meta-identity.service";
import { MetaUserLinkService } from "./meta-user-link.service";

@Module({
  controllers: [MetaCallbacksController, MetaIdentityController],
  providers: [MetaCallbacksService, MetaUserLinkService, MetaIdentityService, MetaGraphApiService],
  exports: [MetaUserLinkService],
})
export class MetaCallbacksModule {}
