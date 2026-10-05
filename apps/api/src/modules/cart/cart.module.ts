import { Module } from "@nestjs/common";
import { CartService } from "./cart.service";
import { OrderModule } from "../orders/order.module";
import { QueueModule } from "../../queue/queue.module";
import { OpportunityModule } from "../opportunities/opportunity.module";

@Module({
  imports: [OrderModule, QueueModule, OpportunityModule],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
