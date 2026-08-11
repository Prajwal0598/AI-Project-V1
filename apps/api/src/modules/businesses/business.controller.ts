import { Body, Controller, Get, Post } from "@nestjs/common";
import { BusinessService } from "./business.service";
import { CreateBusinessDto } from "./dto/create-business.dto";

@Controller("businesses")
export class BusinessController {
  constructor(private readonly businesses: BusinessService) {}

  @Get()
  findAll() {
    return this.businesses.findAll();
  }

  @Post()
  create(@Body() input: CreateBusinessDto) {
    return this.businesses.create(input);
  }
}
