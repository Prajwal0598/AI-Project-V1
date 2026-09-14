import { Module } from "@nestjs/common";
import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";
import { CategoryModule } from "../categories/category.module";
import { InventoryModule } from "../inventory/inventory.module";
import { OpportunityModule } from "../opportunities/opportunity.module";

@Module({ imports: [CategoryModule, InventoryModule, OpportunityModule], controllers: [ProductController], providers: [ProductService] })
export class ProductModule {}
