import { IsIn, IsObject, IsOptional } from "class-validator";

export class UpdateImportRowDto {
  // partial patch merged into the row's normalizedData (e.g. { price: 799 } to fix an invalid price)
  @IsOptional()
  @IsObject()
  normalizedData?: Record<string, unknown>;

  @IsOptional()
  @IsIn(["CREATE", "UPDATE", "SKIP"])
  action?: "CREATE" | "UPDATE" | "SKIP";
}
