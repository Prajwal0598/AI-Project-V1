import { Body, Controller, Get, HttpCode, Post, SetMetadata } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { User } from "@prisma/client";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { Public, IS_PUBLIC_KEY } from "./public.decorator";
import { GetUser } from "../../common/get-user.decorator";

@Public()
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // overrides the class-level @Public() — this route needs a valid JWT
  @SetMetadata(IS_PUBLIC_KEY, false)
  @Get("me")
  me(@GetUser() user: User) {
    return { id: user.id, email: user.email, name: user.name, role: user.role, businessId: user.businessId };
  }

  // stricter limit than the API default to slow down credential-stuffing / brute force attempts
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("register")
  register(@Body() input: RegisterDto) {
    return this.auth.register(input);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  login(@Body() input: LoginDto) {
    return this.auth.login(input);
  }
}
