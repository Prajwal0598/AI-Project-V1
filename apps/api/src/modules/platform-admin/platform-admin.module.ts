import { Module } from "@nestjs/common";
import { PlatformAdminController } from "./platform-admin.controller";
import { PlatformAdminService } from "./platform-admin.service";
import { DataErasureController } from "./data-erasure/data-erasure.controller";
import { DataErasureService } from "./data-erasure/data-erasure.service";
import { MetaCallbackAdminController } from "./meta-callbacks/meta-callback-admin.controller";
import { MetaCallbackAdminService } from "./meta-callbacks/meta-callback-admin.service";
import { MetaDeauthorizationAdminController } from "./meta-callbacks/meta-deauthorization-admin.controller";
import { MetaDeauthorizationAdminService } from "./meta-callbacks/meta-deauthorization-admin.service";
import { MetaGraphApiService } from "../integrations/whatsapp-embedded-signup/meta-graph-api.service";

@Module({
  controllers: [PlatformAdminController, DataErasureController, MetaCallbackAdminController, MetaDeauthorizationAdminController],
  providers: [PlatformAdminService, DataErasureService, MetaCallbackAdminService, MetaDeauthorizationAdminService, MetaGraphApiService],
})
export class PlatformAdminModule {}
