import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { CategoryService } from "./category.service";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";

@Controller()
export class CategoryController {
  constructor(private readonly categories: CategoryService) {}

  @Get("businesses/:businessId/categories")
  findAll(@Param("businessId") businessId: string, @GetUser() user: User) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.categories.findAll(businessId);
  }

  @Post("businesses/:businessId/categories")
  create(@Param("businessId") businessId: string, @GetUser() user: User, @Body() input: CreateCategoryDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.categories.create(businessId, input);
  }

  @Patch("categories/:categoryId")
  update(@Param("categoryId") categoryId: string, @GetUser() user: User, @Body() input: UpdateCategoryDto) {
    return this.categories.update(categoryId, user.businessId, input);
  }

  @Delete("categories/:categoryId")
  remove(@Param("categoryId") categoryId: string, @GetUser() user: User) {
    return this.categories.remove(categoryId, user.businessId);
  }
}
