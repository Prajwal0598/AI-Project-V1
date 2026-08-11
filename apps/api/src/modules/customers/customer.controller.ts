import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CustomerService } from "./customer.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { CreateIdentityDto } from "./dto/create-identity.dto";

@Controller()
export class CustomerController {
  constructor(private readonly customers: CustomerService) {}

  @Get("businesses/:businessId/customers")
  list(@Param("businessId") businessId: string, @Query("search") search?: string) {
    return this.customers.list(businessId, search);
  }

  @Post("businesses/:businessId/customers")
  create(@Param("businessId") businessId: string, @Body() input: CreateCustomerDto) {
    return this.customers.create(businessId, input);
  }

  @Get("customers/:customerId")
  get(@Param("customerId") customerId: string) {
    return this.customers.get(customerId);
  }

  @Post("customers/:customerId/identities")
  addIdentity(@Param("customerId") customerId: string, @Body() input: CreateIdentityDto) {
    return this.customers.addIdentity(customerId, input);
  }
}
