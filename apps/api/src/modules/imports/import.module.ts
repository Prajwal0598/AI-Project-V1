import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { CategoryModule } from "../categories/category.module";

@Module({
  imports: [CategoryModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
