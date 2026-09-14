import { IsIn, IsString } from "class-validator";

export class CreateProductRelationDto {
  @IsString()
  productId!: string;

  @IsString()
  relatedProductId!: string;

  @IsIn(["CROSS_SELL", "UPSELL"])
  type!: "CROSS_SELL" | "UPSELL";
}
