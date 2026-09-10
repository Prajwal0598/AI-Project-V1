import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { User } from "@prisma/client";
import { ROLES_KEY } from "./roles.decorator";

/** Enforces @Roles(...) on a route — requires JwtAuthGuard to have already attached req.user. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest().user as User | undefined;
    if (!user || !required.includes(user.role)) throw new ForbiddenException("You don't have permission to perform this action.");
    return true;
  }
}
