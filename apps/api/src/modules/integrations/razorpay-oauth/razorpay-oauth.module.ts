import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { RazorpayOAuthController } from "./razorpay-oauth.controller";
import { RazorpayOAuthService } from "./razorpay-oauth.service";
import { RazorpayOAuthApiService } from "./razorpay-oauth-api.service";

@Module({
  imports: [AuthModule], // re-uses AuthModule's JwtService for signing/verifying the short-lived OAuth `state`
  controllers: [RazorpayOAuthController],
  providers: [RazorpayOAuthService, RazorpayOAuthApiService],
})
export class RazorpayOAuthModule {}
