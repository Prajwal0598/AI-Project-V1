import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString } from "class-validator";

const BULK_ACTIONS = ["publish", "hide", "draft", "delete", "setCategory"] as const;
export type BulkProductAction = (typeof BULK_ACTIONS)[number];

export class BulkUpdateProductsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  productIds!: string[];

  @IsIn(BULK_ACTIONS)
  action!: BulkProductAction;

  /** category name — required when action is "setCategory" (resolved/created via CategoryService, same as manual product edit) */
  @IsOptional()
  @IsString()
  category?: string;
}
