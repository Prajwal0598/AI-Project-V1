import { Module } from "@nestjs/common";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";
import { OrderModule } from "../orders/order.module";
import { ConversationModule } from "../conversations/conversation.module";

@Module({ imports: [OrderModule, ConversationModule], controllers: [AiController], providers: [AiService], exports: [AiService] })
export class AiModule {}
