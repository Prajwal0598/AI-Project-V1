import "reflect-metadata";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { MetaIdentityController } from "./meta-identity.controller";
import { MetaIdentityService } from "./meta-identity.service";
import { PrismaService } from "../../../database/prisma.service";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { JwtStrategy } from "../../auth/jwt.strategy";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";

const SECRET = "identity-controller-spec-jwt-secret-not-real";
const PATH = "/api/integrations/meta/identity/verify";

const users: Record<string, Record<string, unknown>> = {
  owner: { id: "user-owner", businessId: "biz-owner", role: "OWNER", isPlatformAdmin: false },
  admin: { id: "user-admin", businessId: "biz-admin", role: "ADMIN", isPlatformAdmin: false },
  member: { id: "user-member", businessId: "biz-member", role: "MEMBER", isPlatformAdmin: false },
};

describe("MetaIdentityController", () => {
  const ORIGINAL_ENV = { ...process.env };
  let app: INestApplication;
  let port: number;
  let identity: { verifyAndLink: jest.Mock };
  const jwt = new JwtService({ secret: SECRET });
  const tokenFor = (key: string) => jwt.sign({ sub: users[key].id });

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, JWT_SECRET: SECRET };
    identity = { verifyAndLink: jest.fn().mockResolvedValue({ verified: true }) };
    const prisma = { user: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => Object.values(users).find((u) => u.id === where.id) ?? null) } };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [MetaIdentityController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: MetaIdentityService, useValue: identity },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    process.env = ORIGINAL_ENV;
  });

  const post = (opts: { authorization?: string; json?: unknown }) =>
    new Promise<number>((resolve, reject) => {
      const payload = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
      const headers: Record<string, string> = {};
      if (opts.authorization) headers.Authorization = opts.authorization;
      if (payload !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(payload)); }
      const req = request({ host: "127.0.0.1", port, path: PATH, method: "POST", headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  it("is not public and is mounted under integrations/meta/identity", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetaIdentityController)).toBeUndefined();
    expect(Reflect.getMetadata("path", MetaIdentityController)).toBe("integrations/meta/identity");
  });

  it("answers 401 without a valid login and never reaches the service", async () => {
    expect(await post({ json: { code: "abc" } })).toBe(401);
    expect(await post({ authorization: "Bearer not-a-jwt", json: { code: "abc" } })).toBe(401);
    expect(identity.verifyAndLink).not.toHaveBeenCalled();
  });

  it("answers 403 for a MEMBER, who may not link a Facebook account to the workspace", async () => {
    expect(await post({ authorization: `Bearer ${tokenFor("member")}`, json: { code: "abc" } })).toBe(403);
    expect(identity.verifyAndLink).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing code", {}],
    ["an empty code", { code: "" }],
    ["a non-string code", { code: 12345 }],
    ["a code over 2048 characters", { code: "c".repeat(2049) }],
    ["a caller-supplied Facebook user id", { code: "abc", userId: "1234567890" }],
    ["a caller-supplied businessId", { code: "abc", businessId: "biz-victim" }],
    ["a browser-supplied signedRequest", { code: "abc", signedRequest: "sig.payload" }],
  ])("rejects %s with 400", async (_label, json) => {
    expect(await post({ authorization: `Bearer ${tokenFor("owner")}`, json })).toBe(400);
    expect(identity.verifyAndLink).not.toHaveBeenCalled();
  });

  it.each([["owner", "biz-owner"], ["admin", "biz-admin"]])("lets a workspace %s verify, always against their own business", async (key, businessId) => {
    expect(await post({ authorization: `Bearer ${tokenFor(key)}`, json: { code: "auth-code" } })).toBe(200);
    expect(identity.verifyAndLink).toHaveBeenCalledWith(businessId, "auth-code");
  });

  it("surfaces a failed verification as the service's 400", async () => {
    identity.verifyAndLink.mockRejectedValue(new BadRequestException("Meta could not confirm this Facebook login."));
    expect(await post({ authorization: `Bearer ${tokenFor("owner")}`, json: { code: "bad" } })).toBe(400);
  });
});
