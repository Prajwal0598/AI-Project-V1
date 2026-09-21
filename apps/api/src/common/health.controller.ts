import { Controller, ForbiddenException, Get, Headers, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import IORedis from "ioredis";
import { Public } from "../modules/auth/public.decorator";
import { PrismaService } from "../database/prisma.service";

@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const healthy = database && redis;
    res.status(healthy ? 200 : 503);
    return {
      status: healthy ? "ok" : "degraded",
      service: "ai-customer-agent-api",
      timestamp: new Date().toISOString(),
      dependencies: { database, redis },
    };
  }

  // TEMPORARY — one-time bootstrap for the first isPlatformAdmin account, since there's no UI/CLI path to the
  // DB right now. Remove this endpoint once it's been used. Guarded by BOOTSTRAP_ADMIN_SECRET, never by a JWT.
  @Post("bootstrap-platform-admin")
  async bootstrapPlatformAdmin(@Query("email") email: string, @Headers("x-bootstrap-secret") secret: string) {
    const expected = process.env.BOOTSTRAP_ADMIN_SECRET;
    if (!expected || secret !== expected) throw new ForbiddenException();
    const user = await this.prisma.user.update({ where: { email }, data: { isPlatformAdmin: true } });
    return { id: user.id, email: user.email, isPlatformAdmin: user.isPlatformAdmin };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      return (await redis.ping()) === "PONG";
    } catch {
      return false;
    } finally {
      redis.disconnect();
    }
  }
}
