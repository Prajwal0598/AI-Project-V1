import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { User } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { GetUser } from "../../../common/get-user.decorator";
import { Roles } from "../../../common/roles.decorator";
import { RolesGuard } from "../../../common/roles.guard";
import { MetaIdentityService } from "./meta-identity.service";
import { VerifyFacebookIdentityDto } from "./dto/verify-facebook-identity.dto";

/** Authenticated (the global JWT guard applies): the business always comes from the signed-in user, never the request body. */
@Controller("integrations/meta/identity")
export class MetaIdentityController {
  constructor(private readonly identity: MetaIdentityService) {}

  @Post("verify")
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@GetUser() user: User, @Body() input: VerifyFacebookIdentityDto) {
    return this.identity.verifyAndLink(user.businessId, input.code);
  }
}
