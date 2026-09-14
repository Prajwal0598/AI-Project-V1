import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";

export class UpdateAutomationRuleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoSend?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  businessHoursStart?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  businessHoursEnd?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  frequencyCapPerCustomerPerDay?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minConfidenceForAutoSend?: number;

  @IsOptional()
  @IsBoolean()
  personalizedTiming?: boolean;
}
