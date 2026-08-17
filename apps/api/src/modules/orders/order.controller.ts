import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { OrderService } from "./order.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";

@Controller()
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Get("businesses/:businessId/orders")
  findAll(@Param("businessId") businessId: string) {
    return this.orders.findAll(businessId);
  }

  @Post("businesses/:businessId/orders")
  create(@Param("businessId") businessId: string, @Body() input: CreateOrderDto) {
    return this.orders.create(businessId, input);
  }

  @Patch("orders/:orderId/status")
  updateStatus(@Param("orderId") orderId: string, @GetUser() user: User, @Body() input: UpdateOrderStatusDto) {
    return this.orders.updateStatus(orderId, user.businessId, input);
  }
}
