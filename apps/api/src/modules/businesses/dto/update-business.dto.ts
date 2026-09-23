import { IsBoolean, IsNumber, IsOptional, IsString, Min } from "class-validator";
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

  // used by any variant without its own lowStockThreshold override
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  defaultLowStockThreshold?: number;

  // fallback reorder window (days) used by the REPEAT_PURCHASE opportunity scan when a customer has only bought a product once
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  defaultRepeatPurchaseDays?: number;

  // master switch for the AI Opportunities/Suggestions inbox — off by default so existing businesses see no behavior change
  @IsOptional()
  @IsBoolean()
  proactiveSuggestionsEnabled?: boolean;

  // master switch for natural-language product discovery/recommendation in the free-text AI flow — off by default
  @IsOptional()
  @IsBoolean()
  assistedBuyingEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  assistedBuyingMaxRecommendations?: number;

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

  // Razorpay keyId is not sensitive on its own (needed to know which secret to decrypt) — stored plain
  @IsOptional()
  @IsString()
  razorpayKeyId?: string;

  @IsOptional()
  @IsString()
  razorpayKeySecret?: string;

  @IsOptional()
  @IsString()
  razorpayWebhookSecret?: string;
}
