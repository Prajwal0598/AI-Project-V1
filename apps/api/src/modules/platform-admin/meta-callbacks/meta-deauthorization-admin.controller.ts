import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { User } from "@prisma/client";
import { PlatformAdminGuard } from "../../../common/platform-admin.guard";
import { ListDeauthorizationsQueryDto, PreviewDeauthorizationDto, ResolveDeauthorizationDto } from "./meta-deauthorization-admin.dto";
import { MetaDeauthorizationAdminService } from "./meta-deauthorization-admin.service";

/**
 * Review and close Meta deauthorization events that matched a stored link while identity matching is unverified (NO_ACTION_UNVERIFIED).
 * Deliberately a separate controller from the data-deletion review: different path, different DTOs, different service, and each
 * refuses the other's records. Every route sits behind the global JwtAuthGuard AND PlatformAdminGuard, is rate limited, and is never
 * @Public. Merchants cannot reach it.
 */
@Controller("platform/meta-deauthorizations")
@UseGuards(PlatformAdminGuard)
export class MetaDeauthorizationAdminController {
  constructor(private readonly admin: MetaDeauthorizationAdminService) {}

  /** Newest first; defaults to the events awaiting review. */
  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  list(@Query() query: ListDeauthorizationsQueryDto) {
    return this.admin.list(query);
  }

  /** One event with its audit history. */
  @Get(":id")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  detail(@Param("id") id: string) {
    return this.admin.get(id);
  }

  /** Dry run — shows the candidate businesses and what the outcome would do, changes nothing. */
  @Post(":id/resolve/preview")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  preview(@Param("id") id: string, @Body() dto: PreviewDeauthorizationDto) {
    return this.admin.previewResolution(id, dto);
  }

  /** Disconnects only the named businesses, or records that nothing changes — needs the exact confirmation text, a reference and a verification method. */
  @Post(":id/resolve")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resolve(@Param("id") id: string, @Body() dto: ResolveDeauthorizationDto, @Req() req: { user: User }) {
    return this.admin.resolve(id, dto, req.user.id);
  }
}
