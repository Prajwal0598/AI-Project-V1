import { IsInt, IsOptional, IsString, MinLength } from "class-validator";
import { Type } from "class-transformer";

export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}
