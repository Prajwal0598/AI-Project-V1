import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { CustomerService } from "./customer.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { CreateIdentityDto } from "./dto/create-identity.dto";

@Controller()
export class CustomerController {
  constructor(private readonly customers: CustomerService) {}

  @Get("businesses/:businessId/customers")
  list(@Param("businessId") businessId: string, @GetUser() user: User, @Query("search") search?: string) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.customers.list(businessId, search);
  }

  @Post("businesses/:businessId/customers")
  create(@Param("businessId") businessId: string, @GetUser() user: User, @Body() input: CreateCustomerDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.customers.create(businessId, input);
  }

  @Get("customers/:customerId")
  get(@Param("customerId") customerId: string, @GetUser() user: User) {
    return this.customers.get(customerId, user.businessId);
  }

  @Post("customers/:customerId/identities")
  addIdentity(@Param("customerId") customerId: string, @GetUser() user: User, @Body() input: CreateIdentityDto) {
    return this.customers.addIdentity(customerId, user.businessId, input);
  }
}
