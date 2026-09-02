import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { Public } from "./public.decorator";

@Public()
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
