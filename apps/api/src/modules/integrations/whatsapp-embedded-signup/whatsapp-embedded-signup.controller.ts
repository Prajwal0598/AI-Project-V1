import { Body, Controller, Get, Post } from "@nestjs/common";
import type { User } from "@prisma/client";
import { GetUser } from "../../../common/get-user.decorator";
import { WhatsAppEmbeddedSignupService } from "./whatsapp-embedded-signup.service";
import { CompleteEmbeddedSignupDto } from "./dto/complete-embedded-signup.dto";

@Controller("integrations/whatsapp")
export class WhatsAppEmbeddedSignupController {
  constructor(private readonly embeddedSignup: WhatsAppEmbeddedSignupService) {}

  @Get()
  getStatus(@GetUser() user: User) {
    return this.embeddedSignup.getStatus(user.businessId);
  }

  // businessId always comes from the authenticated user, never the request body — the frontend never gets a
  // say in which business this onboarding result is applied to
  @Post("embedded-signup/complete")
  complete(@GetUser() user: User, @Body() input: CompleteEmbeddedSignupDto) {
    return this.embeddedSignup.completeOnboarding(user.businessId, input);
  }

  @Post("disconnect")
  disconnect(@GetUser() user: User) {
    return this.embeddedSignup.disconnect(user.businessId);
  }
}
