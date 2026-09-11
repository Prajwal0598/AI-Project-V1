import { IsBoolean, IsInt, IsOptional, IsString, MinLength } from "class-validator";
import { Type } from "class-transformer";

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
