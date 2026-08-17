import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../common/get-user.decorator";
import { ProductService } from "./product.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";

@Controller()
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Get("businesses/:businessId/products")
  findAll(@Param("businessId") businessId: string) {
    return this.products.findAll(businessId);
  }

  @Post("businesses/:businessId/products")
  create(@Param("businessId") businessId: string, @Body() input: CreateProductDto) {
    return this.products.create(businessId, input);
  }

  @Patch("products/:productId")
  update(@Param("productId") productId: string, @GetUser() user: User, @Body() input: UpdateProductDto) {
    return this.products.update(productId, user.businessId, input);
  }
}
