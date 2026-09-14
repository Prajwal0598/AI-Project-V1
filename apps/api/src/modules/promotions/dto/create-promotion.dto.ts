import { PromotionTargetSegment } from "@prisma/client";
import { IsEnum, IsOptional, IsString, MinLength, ValidateIf } from "class-validator";

export class CreatePromotionDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  message!: string;

  @IsOptional()
  @IsString()
  discountDescription?: string;

  @IsEnum(PromotionTargetSegment)
  targetSegment!: PromotionTargetSegment;

  @ValidateIf((o) => o.targetSegment === PromotionTargetSegment.CATEGORY_BUYERS)
  @IsString()
  @MinLength(1)
  categoryId?: string;
}
