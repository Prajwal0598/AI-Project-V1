import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { Roles } from "../../common/roles.decorator";
import { RolesGuard } from "../../common/roles.guard";
import { BusinessService } from "./business.service";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";

@Controller("businesses")
export class BusinessController {
  constructor(private readonly businesses: BusinessService) {}

  @Get()
  findAll() {
    return this.businesses.findAll();
  }

  @Post()
  create(@Body() input: CreateBusinessDto) {
    return this.businesses.create(input);
  }

  @Get(":id")
  getOne(@Param("id") id: string, @GetUser() user: User) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.get(id);
  }

  @Get(":id/stats")
  stats(@Param("id") id: string, @GetUser() user: User) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.stats(id);
  }

  @Get(":id/activity")
  activity(@Param("id") id: string, @GetUser() user: User, @Query("limit") limit?: string) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.activity(id, limit ? parseInt(limit, 10) : 20);
  }

  @Get(":id/ai-actions")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  aiActions(@Param("id") id: string, @GetUser() user: User, @Query("limit") limit?: string) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.aiActions(id, limit ? parseInt(limit, 10) : 50);
  }

  @Get(":id/funnel")
  funnel(@Param("id") id: string, @GetUser() user: User) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.funnel(id);
  }

  @Get(":id/revenue-by-channel")
  revenueByChannel(@Param("id") id: string, @GetUser() user: User) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.revenueByChannel(id);
  }

  @Get(":id/customer-metrics")
  customerMetrics(@Param("id") id: string, @GetUser() user: User) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.customerMetrics(id);
  }

  @Get(":id/conversation-outcomes")
  conversationOutcomes(@Param("id") id: string, @GetUser() user: User) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.conversationOutcomes(id);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  update(@Param("id") id: string, @GetUser() user: User, @Body() input: UpdateBusinessDto) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.update(id, input);
  }
}
