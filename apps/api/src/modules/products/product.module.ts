import { Module } from "@nestjs/common";
import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";
import { CategoryModule } from "../categories/category.module";
import { InventoryModule } from "../inventory/inventory.module";

@Module({ imports: [CategoryModule, InventoryModule], controllers: [ProductController], providers: [ProductService] })
export class ProductModule {}
