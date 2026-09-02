import { Module } from "@nestjs/common";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { OrderModule } from "../orders/order.module";

@Module({ imports: [OrderModule], controllers: [AiController], providers: [AiService] })
export class AiModule {}
