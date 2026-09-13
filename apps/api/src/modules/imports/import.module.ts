import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { ImportAiService } from "./import-ai.service";
import { CategoryModule } from "../categories/category.module";
import { InventoryModule } from "../inventory/inventory.module";

@Module({
  imports: [CategoryModule, InventoryModule],
  controllers: [ImportController],
  providers: [ImportService, ImportAiService],
})
export class ImportModule {}
