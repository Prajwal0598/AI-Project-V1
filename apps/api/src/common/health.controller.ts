import { Controller, Get } from "@nestjs/common";
import { Public } from "../modules/auth/public.decorator";

@Public()
@Controller("health")
export class HealthController {
  @Get()
  check() {
    return { status: "ok", service: "ai-customer-agent-api", timestamp: new Date().toISOString() };
  }
}
