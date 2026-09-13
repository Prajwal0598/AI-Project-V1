import { Module } from "@nestjs/common";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { QueueModule } from "../../queue/queue.module";
import { InventoryModule } from "../inventory/inventory.module";
import { OpportunityModule } from "../opportunities/opportunity.module";

@Module({ imports: [QueueModule, InventoryModule, OpportunityModule], controllers: [OrderController], providers: [OrderService], exports: [OrderService] })
export class OrderModule {}
