import { Module } from "@nestjs/common";
import { ProductRelationController } from "./product-relation.controller";
import { ProductRelationService } from "./product-relation.service";

@Module({
  controllers: [ProductRelationController],
  providers: [ProductRelationService],
  exports: [ProductRelationService],
})
export class ProductRelationModule {}
