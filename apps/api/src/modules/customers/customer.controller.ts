import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CreateCustomerInput, CreateIdentityInput, CustomerService } from "./customer.service";

@Controller()
export class CustomerController {
  constructor(private readonly customers: CustomerService) {}

  @Get("businesses/:businessId/customers")
  list(@Param("businessId") businessId: string, @Query("search") search?: string) {
    return this.customers.list(businessId, search);
  }

  @Post("businesses/:businessId/customers")
  create(@Param("businessId") businessId: string, @Body() input: CreateCustomerInput) {
    return this.customers.create(businessId, input);
  }

  @Get("customers/:customerId")
  get(@Param("customerId") customerId: string) {
    return this.customers.get(customerId);
  }

  @Post("customers/:customerId/identities")
  addIdentity(@Param("customerId") customerId: string, @Body() input: CreateIdentityInput) {
    return this.customers.addIdentity(customerId, input);
  }
}
