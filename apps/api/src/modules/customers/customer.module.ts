import { Module } from "@nestjs/common";
import { CustomerController } from "./customer.controller";
import { CustomerService } from "./customer.service";
import { BusinessModule } from "../businesses/business.module";
import { ConversationModule } from "../conversations/conversation.module";
import { OrderModule } from "../orders/order.module";
import { OpportunityModule } from "../opportunities/opportunity.module";
import { CustomerSignalModule } from "../customer-signals/customer-signal.module";

@Module({
  imports: [BusinessModule, ConversationModule, OrderModule, OpportunityModule, CustomerSignalModule],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}

