import { Body, Controller, Delete, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { GetUser } from "../../common/get-user.decorator";
import { PromotionService } from "./promotion.service";
import { CreatePromotionDto } from "./dto/create-promotion.dto";

@Controller()
export class PromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get("businesses/:businessId/promotions")
  list(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.promotions.list(businessId);
  }

  @Post("businesses/:businessId/promotions")
  create(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }, @Body() input: CreatePromotionDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.promotions.create(businessId, input);
  }

  @Post("promotions/:id/broadcast")
  broadcast(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.promotions.broadcast(id, user.businessId);
  }

  @Delete("promotions/:id")
  remove(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.promotions.remove(id, user.businessId);
  }
}
