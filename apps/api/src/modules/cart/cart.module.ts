import { Module } from "@nestjs/common";
import { CartService } from "./cart.service";
import { OrderModule } from "../orders/order.module";
import { QueueModule } from "../../queue/queue.module";

@Module({
  imports: [OrderModule, QueueModule],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
