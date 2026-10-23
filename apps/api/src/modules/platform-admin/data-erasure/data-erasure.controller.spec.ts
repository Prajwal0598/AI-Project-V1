import "reflect-metadata";
import { BadRequestException, ForbiddenException, ValidationPipe } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { PlatformAdminGuard } from "../../../common/platform-admin.guard";
import { AppModule } from "../../../app.module";
import { DataErasureController } from "./data-erasure.controller";
import { ExecuteErasureDto, PreviewErasureDto } from "./data-erasure.dto";

const contextFor = (user: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe("DataErasureController — access control", () => {
  const guards = Reflect.getMetadata("__guards__", DataErasureController) as unknown[];

  it("sits behind PlatformAdminGuard, and the global JwtAuthGuard still applies to the whole app", () => {
    expect(guards).toContain(PlatformAdminGuard);
    const appGuards = (Reflect.getMetadata("providers", AppModule) as { provide?: unknown; useClass?: unknown }[]).filter((p) => p.provide === APP_GUARD).map((p) => p.useClass);
    expect(appGuards).toContain(JwtAuthGuard);
  });

  it("is not public: neither the controller nor either route opts out of authentication", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, DataErasureController)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, DataErasureController.prototype.preview)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, DataErasureController.prototype.execute)).toBeUndefined();
  });

  it("exposes only POST preview and POST execute under platform/data-erasure", () => {
    expect(Reflect.getMetadata("path", DataErasureController)).toBe("platform/data-erasure");
    // 1 = RequestMethod.POST
    expect(Reflect.getMetadata("method", DataErasureController.prototype.preview)).toBe(1);
    expect(Reflect.getMetadata("method", DataErasureController.prototype.execute)).toBe(1);
    expect(Reflect.getMetadata("path", DataErasureController.prototype.preview)).toBe("customers/preview");
    expect(Reflect.getMetadata("path", DataErasureController.prototype.execute)).toBe("customers/execute");
  });

  it("turns away a merchant user, an unauthenticated request, and an account without the platform-admin flag", () => {
    const guard = new PlatformAdminGuard();
    expect(() => guard.canActivate(contextFor({ id: "u1", role: "OWNER", isPlatformAdmin: false }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor({ id: "u2", isPlatformAdmin: true }))).toBe(true);
  });

  it("rate limits both routes", () => {
    for (const handler of [DataErasureController.prototype.preview, DataErasureController.prototype.execute]) {
      const keys = Reflect.getMetadataKeys(handler).map(String);
      expect(keys.some((k) => k.includes("THROTTLER"))).toBe(true);
    }
  });
});

describe("erasure request validation", () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validBody = {
    businessId: "clbusiness0001", customerId: "clcustomer0001", requestReference: "TICKET-1042", requestedBy: "CUSTOMER",
    verificationMethod: "EMAIL_FROM_REGISTERED_ADDRESS", confirm: "ERASE clcustomer0001",
  };
  const execute = (body: object) => pipe.transform(body, { type: "body", metatype: ExecuteErasureDto });

  it("accepts a complete, well-formed request", async () => {
    await expect(execute(validBody)).resolves.toMatchObject({ requestReference: "TICKET-1042" });
    await expect(execute({ ...validBody, acknowledgeOpenOrders: true })).resolves.toMatchObject({ acknowledgeOpenOrders: true });
    await expect(pipe.transform({ businessId: validBody.businessId, customerId: validBody.customerId }, { type: "body", metatype: PreviewErasureDto })).resolves.toBeDefined();
  });

  it.each([
    ["a reference that could carry an email address", { requestReference: "asha@example.com" }],
    ["a reference with spaces", { requestReference: "ticket 1042" }],
    ["a reference that is too short", { requestReference: "A1" }],
    ["an unknown requester type", { requestedBy: "ANYONE" }],
    ["an unknown verification method", { verificationMethod: "TRUST_ME" }],
    ["a missing verification method", { verificationMethod: undefined }],
    ["a missing confirmation", { confirm: undefined }],
    ["an id that is not a plain id", { customerId: "x; DROP TABLE" }],
    ["a business id that is too short", { businessId: "b1" }],
    ["a non-boolean acknowledgement", { acknowledgeOpenOrders: "yes" }],
  ])("rejects %s", async (_label, change) => {
    await expect(execute({ ...validBody, ...change })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects fields it does not know, so nothing unexpected reaches the service", async () => {
    await expect(execute({ ...validBody, deleteEverything: true })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ businessId: validBody.businessId, customerId: validBody.customerId, extra: 1 }, { type: "body", metatype: PreviewErasureDto })).rejects.toBeInstanceOf(BadRequestException);
  });
});
