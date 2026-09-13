import { Module } from "@nestjs/common";
import { CustomerSignalService } from "./customer-signal.service";

@Module({
  providers: [CustomerSignalService],
  exports: [CustomerSignalService],
})
export class CustomerSignalModule {}
