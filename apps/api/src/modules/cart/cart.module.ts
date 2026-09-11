import { Module } from "@nestjs/common";
import { CartService } from "./cart.service";
import { OrderModule } from "../orders/order.module";

@Module({
  imports: [OrderModule],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
