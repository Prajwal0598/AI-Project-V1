import { Body, Controller, Delete, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { GetUser } from "../../common/get-user.decorator";
import { ProductRelationService } from "./product-relation.service";
import { CreateProductRelationDto } from "./dto/create-product-relation.dto";

@Controller()
export class ProductRelationController {
  constructor(private readonly relations: ProductRelationService) {}

  @Get("products/:productId/relations")
  list(@Param("productId") productId: string, @GetUser() user: { businessId: string }) {
    return this.relations.list(user.businessId, productId);
  }

  @Post("businesses/:businessId/product-relations")
  create(@Param("businessId") businessId: string, @GetUser() user: { businessId: string }, @Body() input: CreateProductRelationDto) {
    if (user.businessId !== businessId) throw new ForbiddenException();
    return this.relations.create(businessId, input);
  }

  @Delete("product-relations/:id")
  remove(@Param("id") id: string, @GetUser() user: { businessId: string }) {
    return this.relations.remove(id, user.businessId);
  }
}
