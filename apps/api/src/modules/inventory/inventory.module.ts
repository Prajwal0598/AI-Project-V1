import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { CustomerSignalModule } from "../customer-signals/customer-signal.module";
import { OpportunityModule } from "../opportunities/opportunity.module";

@Module({
  imports: [CustomerSignalModule, OpportunityModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
