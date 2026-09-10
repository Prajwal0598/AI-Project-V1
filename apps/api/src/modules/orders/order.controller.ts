import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { User } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { Roles } from "../../common/roles.decorator";
import { RolesGuard } from "../../common/roles.guard";
import { OrderService } from "./order.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { UpdateFulfillmentStatusDto } from "./dto/update-fulfillment-status.dto";

@Controller()
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Get("businesses/:businessId/orders")
  findAll(@Param("businessId") businessId: string, @GetUser() user: User) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.orders.findAll(businessId);
  }

  @Post("businesses/:businessId/orders")
  create(@Param("businessId") businessId: string, @GetUser() user: User, @Body() input: CreateOrderDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.orders.create(businessId, input);
  }

  @Patch("orders/:orderId/status")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  updateStatus(@Param("orderId") orderId: string, @GetUser() user: User, @Body() input: UpdateOrderStatusDto) {
    return this.orders.updateStatus(orderId, user.businessId, input);
  }

  @Patch("orders/:orderId/approve")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  approve(@Param("orderId") orderId: string, @GetUser() user: User) {
    return this.orders.approve(orderId, user.businessId);
  }

  @Patch("orders/:orderId/fulfillment")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  updateFulfillment(@Param("orderId") orderId: string, @GetUser() user: User, @Body() input: UpdateFulfillmentStatusDto) {
    return this.orders.updateFulfillmentStatus(orderId, user.businessId, input.fulfillmentStatus);
  }
}

