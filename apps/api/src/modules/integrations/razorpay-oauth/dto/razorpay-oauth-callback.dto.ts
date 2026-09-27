import { IsOptional, IsString, MinLength } from "class-validator";

// query params on the public GET /integrations/razorpay/callback redirect from auth.razorpay.com — code/state
// are present on success, error is present if the merchant denied/cancelled authorization instead
export class RazorpayOAuthCallbackDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  state?: string;

  @IsOptional()
  @IsString()
  error?: string;
}
