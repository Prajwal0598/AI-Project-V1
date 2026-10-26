import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { User } from "@prisma/client";
import { PlatformAdminGuard } from "../../../common/platform-admin.guard";
import { ListMetaCallbacksQueryDto, PreviewResolutionDto, ResolveMetaCallbackDto } from "./meta-callback-admin.dto";
import { MetaCallbackAdminService } from "./meta-callback-admin.service";

/**
 * Review and close Meta data-deletion requests that could not be matched automatically. Every route sits behind the global
 * JwtAuthGuard AND PlatformAdminGuard, is rate limited, and is never @Public. Merchants cannot reach it.
 */
@Controller("platform/meta-callbacks")
@UseGuards(PlatformAdminGuard)
export class MetaCallbackAdminController {
  constructor(private readonly admin: MetaCallbackAdminService) {}

  /** Newest first; filter with ?status=PENDING_REVIEW&kind=DATA_DELETION&take=25. */
  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  list(@Query() query: ListMetaCallbacksQueryDto) {
    return this.admin.list(query);
  }

  /** One request with its audit history. */
  @Get(":id")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  detail(@Param("id") id: string) {
    return this.admin.get(id);
  }

  /** Dry run — reports what resolving would do, changes nothing. */
  @Post(":id/resolve/preview")
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  preview(@Param("id") id: string, @Body() dto: PreviewResolutionDto) {
    return this.admin.previewResolution(id, dto);
  }

  /** Destructive for the named workspaces' WhatsApp connection — needs the exact confirmation text, a reference and the verification method. */
  @Post(":id/resolve")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resolve(@Param("id") id: string, @Body() dto: ResolveMetaCallbackDto, @Req() req: { user: User }) {
    return this.admin.resolve(id, dto, req.user.id);
  }
}
