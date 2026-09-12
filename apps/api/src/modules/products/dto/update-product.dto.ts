import { IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Min } from "class-validator";
import { Type } from "class-transformer";
import { ProductStatus } from "@prisma/client";

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Type(() => Number)
  price?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  inventory?: number;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
