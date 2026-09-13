import { IsIn, IsOptional, IsString } from "class-validator";

export class SendSuggestionDto {
  @IsOptional()
  @IsString()
  editedMessage?: string;
}

export class UpdateSuggestionDto {
  @IsString()
  message!: string;
}

export class SnoozeOpportunityDto {
  @IsOptional()
  @IsIn([4, 24, 72])
  hours?: 4 | 24 | 72;
}
