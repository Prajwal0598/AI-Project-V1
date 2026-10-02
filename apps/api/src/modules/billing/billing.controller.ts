import { Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { Roles } from "../../common/roles.decorator";
import { RolesGuard } from "../../common/roles.guard";
import { SubscriptionService } from "./subscription.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Get("plans")
  getPlans() {
    return this.subscriptions.getPlans();
  }

  @Get("subscription")
  getSubscription(@GetUser() user: User) {
    return this.subscriptions.getSubscription(user.businessId);
  }

  @Post("checkout")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  checkout(@GetUser() user: User) {
    return this.subscriptions.checkout(user.businessId);
  }

  @Post("cancel")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  cancel(@GetUser() user: User) {
    return this.subscriptions.cancel(user.businessId);
  }

  @Post("resume")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  resume(@GetUser() user: User) {
    return this.subscriptions.resume(user.businessId);
  }

  @Get("history")
  history(@GetUser() user: User, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.subscriptions.history(user.businessId, page ? parseInt(page, 10) : undefined, pageSize ? parseInt(pageSize, 10) : undefined);
  }
}
