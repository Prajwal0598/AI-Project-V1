import { IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";

export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  whatsappPhoneNumberId?: string;

  @IsOptional()
  @IsString()
  instagramPageId?: string;

  @IsOptional()
  @IsString()
  supportEmail?: string;

  // orders above this total require merchant approval before the AI can proceed to payment/fulfillment; null/omitted = no cap
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Type(() => Number)
  autonomyMaxOrderValue?: number | null;

  // plaintext in transit (HTTPS), encrypted at rest — an empty string clears the stored credential
  @IsOptional()
  @IsString()
  whatsappAccessToken?: string;

  @IsOptional()
  @IsString()
  instagramAccessToken?: string;

  @IsOptional()
  @IsString()
  postmarkServerToken?: string;
}
