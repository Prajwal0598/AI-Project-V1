import { Module } from "@nestjs/common";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";
import { QueueModule } from "../../queue/queue.module";

@Module({ imports: [QueueModule], controllers: [OrderController], providers: [OrderService], exports: [OrderService] })
export class OrderModule {}
