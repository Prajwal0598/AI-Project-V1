import { Controller, Get, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { User } from "@prisma/client";
import { GetUser } from "../../../common/get-user.decorator";
import { Public } from "../../auth/public.decorator";
import { RazorpayOAuthService } from "./razorpay-oauth.service";
import { RazorpayOAuthCallbackDto } from "./dto/razorpay-oauth-callback.dto";

function settingsRedirectUrl(query: string): string {
  const webOrigin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || "http://localhost:3000";
  return `${webOrigin}/settings?${query}`;
}

@Controller("integrations/razorpay")
export class RazorpayOAuthController {
  constructor(private readonly razorpayOAuth: RazorpayOAuthService) {}

  @Get()
  getStatus(@GetUser() user: User) {
    return this.razorpayOAuth.getStatus(user.businessId);
  }

  // businessId always comes from the authenticated user, never a query/body param — the frontend never gets
  // a say in which business the resulting connection link is issued for
  @Get("authorize-url")
  getAuthorizeUrl(@GetUser() user: User) {
    return { url: this.razorpayOAuth.buildAuthorizeUrl(user.businessId) };
  }

  // PUBLIC: this is a plain browser redirect from auth.razorpay.com, not a fetch call from our SPA — there is
  // no Authorization header here. The signed `state` (see RazorpayOAuthService) is what identifies the
  // business and proves this callback corresponds to a request we actually issued.
  @Public()
  @Get("callback")
  async callback(@Query() query: RazorpayOAuthCallbackDto, @Res() res: Response) {
    if (query.error || !query.code || !query.state) {
      const message = query.error ? "Razorpay connection was cancelled or denied." : "Malformed Razorpay redirect — please try connecting again.";
      res.redirect(302, settingsRedirectUrl(`razorpay=error&message=${encodeURIComponent(message)}`));
      return;
    }
    try {
      await this.razorpayOAuth.handleCallback(query.code, query.state);
      res.redirect(302, settingsRedirectUrl("razorpay=connected"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not complete the Razorpay connection.";
      res.redirect(302, settingsRedirectUrl(`razorpay=error&message=${encodeURIComponent(message)}`));
    }
  }

  @Post("disconnect")
  disconnect(@GetUser() user: User) {
    return this.razorpayOAuth.disconnect(user.businessId);
  }
}
