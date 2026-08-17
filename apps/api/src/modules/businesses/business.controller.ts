import { Body, Controller, ForbiddenException, Get, Param, Patch, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { BusinessService } from "./business.service";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";

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

  @Patch(":id")
  update(@Param("id") id: string, @GetUser() user: User, @Body() input: UpdateBusinessDto) {
    if (user.businessId !== id) throw new ForbiddenException();
    return this.businesses.update(id, input);
  }
}
