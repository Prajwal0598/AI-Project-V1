import { Controller, ForbiddenException, Get, Param, Query } from "@nestjs/common";
import { GetUser } from "../../common/get-user.decorator";
import { InventoryService } from "./inventory.service";

@Controller("businesses/:businessId/inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("alerts")
  alerts(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.inventory.listActiveAlerts(businessId);
  }

  @Get("adjustments")
  adjustments(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }, @Query("variantId") variantId?: string) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.inventory.listAdjustments(businessId, variantId);
  }
}
