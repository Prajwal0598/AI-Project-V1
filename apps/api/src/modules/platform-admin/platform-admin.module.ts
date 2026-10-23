import { Module } from "@nestjs/common";
import { PlatformAdminController } from "./platform-admin.controller";
import { PlatformAdminService } from "./platform-admin.service";
import { DataErasureController } from "./data-erasure/data-erasure.controller";
import { DataErasureService } from "./data-erasure/data-erasure.service";

@Module({
  controllers: [PlatformAdminController, DataErasureController],
  providers: [PlatformAdminService, DataErasureService],
})
export class PlatformAdminModule {}
