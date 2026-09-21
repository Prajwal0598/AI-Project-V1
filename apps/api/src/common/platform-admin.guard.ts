import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { User } from "@prisma/client";

/** Restricts a route to accounts explicitly flagged isPlatformAdmin — requires JwtAuthGuard to have already attached req.user. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as User | undefined;
    if (!user?.isPlatformAdmin) throw new ForbiddenException("Platform admin access required.");
    return true;
  }
}
