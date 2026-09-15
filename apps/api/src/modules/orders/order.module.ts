import { Module } from "@nestjs/common";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { QueueModule } from "../../queue/queue.module";
import { InventoryModule } from "../inventory/inventory.module";
import { OpportunityModule } from "../opportunities/opportunity.module";
import { ProductRelationModule } from "../product-relations/product-relation.module";
import { ConversationModule } from "../conversations/conversation.module";

@Module({ imports: [QueueModule, InventoryModule, OpportunityModule, ProductRelationModule, ConversationModule], controllers: [OrderController], providers: [OrderService], exports: [OrderService] })
export class OrderModule {}
