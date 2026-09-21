import { Controller, Get, UseGuards } from "@nestjs/common";
import { PlatformAdminGuard } from "../../common/platform-admin.guard";
import { PlatformAdminService } from "./platform-admin.service";

@Controller("platform")
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(private readonly platformAdmin: PlatformAdminService) {}

  @Get("overview")
  overview() {
    return this.platformAdmin.overview();
  }

  @Get("businesses")
  businesses() {
    return this.platformAdmin.businesses();
  }
}
