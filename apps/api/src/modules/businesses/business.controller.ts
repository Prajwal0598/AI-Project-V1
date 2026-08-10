import { Body, Controller, Get, Post } from "@nestjs/common";
import { BusinessService, CreateBusinessInput } from "./business.service";

@Controller("businesses")
export class BusinessController {
  constructor(private readonly businesses: BusinessService) {}

  @Get()
  findAll() {
    return this.businesses.findAll();
  }

  @Post()
  create(@Body() input: CreateBusinessInput) {
    return this.businesses.create(input);
  }
}
