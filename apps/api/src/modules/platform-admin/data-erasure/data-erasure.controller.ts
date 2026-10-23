import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { User } from "@prisma/client";
import { PlatformAdminGuard } from "../../../common/platform-admin.guard";
import { ExecuteErasureDto, PreviewErasureDto } from "./data-erasure.dto";
import { DataErasureService } from "./data-erasure.service";

/**
 * Customer-data erasure for platform admins only. Every route sits behind the global JwtAuthGuard AND PlatformAdminGuard,
 * is rate limited, and is never @Public. Merchants cannot reach it.
 */
@Controller("platform/data-erasure")
@UseGuards(PlatformAdminGuard)
export class DataErasureController {
  constructor(private readonly erasure: DataErasureService) {}

  /** Dry run — reports what would be erased and retained, changes nothing. */
  @Post("customers/preview")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  preview(@Body() dto: PreviewErasureDto) {
    return this.erasure.preview(dto);
  }

  /** Destructive — requires the exact confirmation text, a request reference and the verification method. */
  @Post("customers/execute")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  execute(@Body() dto: ExecuteErasureDto, @Req() req: { user: User }) {
    return this.erasure.execute(dto, req.user.id);
  }
}
