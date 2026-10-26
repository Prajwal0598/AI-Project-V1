import "reflect-metadata";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ConflictException, INestApplication, NotFoundException, ValidationPipe } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { MetaCallbackAdminController } from "./meta-callback-admin.controller";
import { MetaDeauthorizationAdminController } from "./meta-deauthorization-admin.controller";
import { MetaDeauthorizationAdminService } from "./meta-deauthorization-admin.service";
import { PrismaService } from "../../../database/prisma.service";
import { PlatformAdminGuard } from "../../../common/platform-admin.guard";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { JwtStrategy } from "../../auth/jwt.strategy";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";

// Real JwtAuthGuard + JwtStrategy + PlatformAdminGuard + ThrottlerGuard + ValidationPipe, wired as in app.module.ts and main.ts.
// Only the database user lookup and the review service are stubbed.

const SECRET = "deauth-controller-spec-jwt-secret-not-real";
const REQUEST_ID = "ckrequest1234567890abc";
const BUSINESS_ID = "ckbusiness1234567890ab";
const BASE = "/api/platform/meta-deauthorizations";

const users: Record<string, Record<string, unknown>> = {
  admin: { id: "user-platform-admin", businessId: "biz-ops", role: "MEMBER", isPlatformAdmin: true },
  owner: { id: "user-merchant-owner", businessId: "biz-1", role: "OWNER", isPlatformAdmin: false },
  merchantAdmin: { id: "user-merchant-admin", businessId: "biz-2", role: "ADMIN", isPlatformAdmin: false },
  member: { id: "user-merchant-member", businessId: "biz-3", role: "MEMBER", isPlatformAdmin: false },
};

const previewBody = { outcome: "DISCONNECT_VERIFIED", businessIds: [BUSINESS_ID] };
const disconnectBody = { outcome: "DISCONNECT_VERIFIED", businessIds: [BUSINESS_ID], verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", resolutionReference: "TICKET-201", confirm: `DISCONNECT_VERIFIED ${REQUEST_ID}` };
const noChangeBody = { outcome: "NO_CHANGE", verificationMethod: "RECORDS_REVIEW", resolutionReference: "TICKET-202", reason: "IDENTITY_NOT_ESTABLISHED", confirm: `NO_CHANGE ${REQUEST_ID}` };

const routes: Array<[string, string, string, unknown]> = [
  ["list", "GET", BASE, undefined],
  ["detail", "GET", `${BASE}/${REQUEST_ID}`, undefined],
  ["preview", "POST", `${BASE}/${REQUEST_ID}/resolve/preview`, previewBody],
  ["resolve", "POST", `${BASE}/${REQUEST_ID}/resolve`, disconnectBody],
];

describe("MetaDeauthorizationAdminController", () => {
  const ORIGINAL_ENV = { ...process.env };
  let app: INestApplication;
  let port: number;
  let admin: Record<"list" | "get" | "previewResolution" | "resolve", jest.Mock>;
  const jwt = new JwtService({ secret: SECRET });
  const tokenFor = (key: string) => jwt.sign({ sub: users[key].id });

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, JWT_SECRET: SECRET };
    admin = {
      list: jest.fn().mockResolvedValue([{ id: REQUEST_ID }]),
      get: jest.fn().mockResolvedValue({ id: REQUEST_ID, events: [] }),
      previewResolution: jest.fn().mockResolvedValue({ dryRun: true }),
      resolve: jest.fn().mockResolvedValue({ requestId: REQUEST_ID, status: "COMPLETED" }),
    };
    const prisma = { user: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => Object.values(users).find((u) => u.id === where.id) ?? null) } };

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [MetaDeauthorizationAdminController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: MetaDeauthorizationAdminService, useValue: admin },
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

  const send = (method: string, path: string, opts: { authorization?: string; json?: unknown } = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
      const headers: Record<string, string> = {};
      if (opts.authorization) headers.Authorization = opts.authorization;
      if (payload !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(payload)); }
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => { let body: unknown = text; try { body = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body }); });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  const asAdmin = (method: string, path: string, json?: unknown) => send(method, path, { authorization: `Bearer ${tokenFor("admin")}`, json });
  const expectServiceUntouched = () => { for (const fn of Object.values(admin)) expect(fn).not.toHaveBeenCalled(); };

  describe("route metadata", () => {
    it("is guarded by PlatformAdminGuard, never public, and separate from the data-deletion review", () => {
      expect(Reflect.getMetadata("__guards__", MetaDeauthorizationAdminController)).toContain(PlatformAdminGuard);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetaDeauthorizationAdminController)).toBeUndefined();
      expect(Reflect.getMetadata("path", MetaDeauthorizationAdminController)).toBe("platform/meta-deauthorizations");
      expect(Reflect.getMetadata("path", MetaCallbackAdminController)).toBe("platform/meta-callbacks");
    });

    it("exposes exactly list, detail, preview and resolve, each rate limited, and nothing that could delete an event", () => {
      const proto = MetaDeauthorizationAdminController.prototype;
      const GET = 0, POST = 1;
      const shape = (handler: unknown) => [Reflect.getMetadata("method", handler as object), Reflect.getMetadata("path", handler as object)];
      expect(shape(proto.list)).toEqual([GET, "/"]);
      expect(shape(proto.detail)).toEqual([GET, ":id"]);
      expect(shape(proto.preview)).toEqual([POST, ":id/resolve/preview"]);
      expect(shape(proto.resolve)).toEqual([POST, ":id/resolve"]);
      expect(Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").sort()).toEqual(["detail", "list", "preview", "resolve"]);
      for (const handler of [proto.list, proto.detail, proto.preview, proto.resolve]) {
        expect(Reflect.getMetadataKeys(handler).some((k) => String(k).startsWith("THROTTLER:LIMIT"))).toBe(true);
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
      }
    });
  });

  describe("unauthenticated access", () => {
    it.each(routes)("%s: answers 401 for a missing, malformed, wrong-scheme, expired or unknown-user token, and never reaches the service", async (_name, method, path, body) => {
      const expired = jwt.sign({ sub: users.admin.id }, { expiresIn: "-10s" });
      const ghost = jwt.sign({ sub: "user-that-does-not-exist" });
      for (const authorization of [undefined, "Bearer not-a-jwt", `Token ${tokenFor("admin")}`, `Bearer ${expired}`, `Bearer ${ghost}`]) {
        expect((await send(method, path, { authorization, json: body })).status).toBe(401);
      }
      expectServiceUntouched();
    });

    it("rejects a token signed with another secret, even when it names a real platform admin", async () => {
      const forged = new JwtService({ secret: "someone-elses-secret" }).sign({ sub: users.admin.id });
      expect((await send("POST", `${BASE}/${REQUEST_ID}/resolve`, { authorization: `Bearer ${forged}`, json: disconnectBody })).status).toBe(401);
      expectServiceUntouched();
    });
  });

  describe("insufficient permissions", () => {
    it.each(routes)("%s: answers 403 for every merchant role, and never reaches the service", async (_name, method, path, body) => {
      for (const key of ["owner", "merchantAdmin", "member"]) {
        expect((await send(method, path, { authorization: `Bearer ${tokenFor(key)}`, json: body })).status).toBe(403);
      }
      expectServiceUntouched();
    });

    it("decides from the stored account, not from claims in the token", async () => {
      const claimed = jwt.sign({ sub: users.owner.id, isPlatformAdmin: true, role: "PLATFORM_ADMIN" });
      expect((await send("POST", `${BASE}/${REQUEST_ID}/resolve`, { authorization: `Bearer ${claimed}`, json: disconnectBody })).status).toBe(403);
      expectServiceUntouched();
    });
  });

  describe("validation errors", () => {
    const longId = (n: number) => `ckbusiness${String(n).padStart(10, "0")}`;

    it.each([
      ["an unknown status", "?status=BOGUS"],
      ["a data-deletion status", "?status=PENDING_REVIEW"],
      ["take below 1", "?take=0"],
      ["take above 100", "?take=101"],
      ["a non-numeric take", "?take=abc"],
      ["a kind filter (this queue is deauthorizations only)", "?kind=DATA_DELETION"],
      ["an unknown query parameter", "?businessId=biz-1"],
    ])("list rejects %s with 400", async (_label, query) => {
      expect((await asAdmin("GET", `${BASE}${query}`)).status).toBe(400);
      expectServiceUntouched();
    });

    it.each([
      ["a missing body", undefined],
      ["an empty body", {}],
      ["an unknown outcome", { outcome: "DELETE_EVERYTHING" }],
      ["a data-deletion outcome", { outcome: "COMPLETED", businessIds: [BUSINESS_ID] }],
      ["businessIds that is not an array", { outcome: "DISCONNECT_VERIFIED", businessIds: BUSINESS_ID }],
      ["a path-like business id", { outcome: "DISCONNECT_VERIFIED", businessIds: ["../etc/passwd"] }],
      ["a non-string business id", { outcome: "DISCONNECT_VERIFIED", businessIds: [12345] }],
      ["more than 10 business ids", { outcome: "DISCONNECT_VERIFIED", businessIds: Array.from({ length: 11 }, (_, i) => longId(i)) }],
      ["duplicate business ids", { outcome: "DISCONNECT_VERIFIED", businessIds: [BUSINESS_ID, BUSINESS_ID] }],
      ["an unexpected property", { ...previewBody, force: true }],
    ])("preview rejects %s with 400", async (_label, body) => {
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve/preview`, body)).status).toBe(400);
      expectServiceUntouched();
    });

    const without = (base: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
    it.each([
      ["a missing body", undefined],
      ["a missing verificationMethod", without(disconnectBody, "verificationMethod")],
      ["an unknown verificationMethod", { ...disconnectBody, verificationMethod: "TRUST_ME" }],
      ["a data-deletion verificationMethod", { ...disconnectBody, verificationMethod: "RECORDS_SEARCH_NO_MATCH" }],
      ["a missing resolutionReference", without(disconnectBody, "resolutionReference")],
      ["a too-short resolutionReference", { ...disconnectBody, resolutionReference: "x" }],
      ["a resolutionReference holding an email address", { ...disconnectBody, resolutionReference: "jane@example.com" }],
      ["a resolutionReference with spaces", { ...disconnectBody, resolutionReference: "ticket 201" }],
      ["a resolutionReference over 64 characters", { ...disconnectBody, resolutionReference: "T".repeat(65) }],
      ["a missing confirm", without(disconnectBody, "confirm")],
      ["an empty confirm", { ...disconnectBody, confirm: "" }],
      ["an unknown reason", { ...noChangeBody, reason: "BECAUSE_I_SAID_SO" }],
      ["a free-text reason", { ...noChangeBody, reason: "merchant jane@example.com called" }],
      ["a caller-supplied resolvedByUserId", { ...disconnectBody, resolvedByUserId: "someone-else" }],
      ["a caller-supplied status", { ...disconnectBody, status: "COMPLETED" }],
      ["a caller-supplied metaUserId", { ...disconnectBody, metaUserId: "1234567890" }],
      ["a path-like business id", { ...disconnectBody, businessIds: ["../x"] }],
    ])("resolve rejects %s with 400", async (_label, body) => {
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, body)).status).toBe(400);
      expectServiceUntouched();
    });
  });

  describe("successful requests", () => {
    it("lists with no filters (the service defaults to events awaiting review)", async () => {
      const res = await asAdmin("GET", BASE);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: REQUEST_ID }]);
      expect(admin.list).toHaveBeenCalledTimes(1);
    });

    it("lists with the validated, typed query", async () => {
      expect((await asAdmin("GET", `${BASE}?status=NO_CHANGE_RECORDED&take=10`)).status).toBe(200);
      expect(admin.list).toHaveBeenCalledWith(expect.objectContaining({ status: "NO_CHANGE_RECORDED", take: 10 }));
    });

    it("returns one event with its audit history", async () => {
      const res = await asAdmin("GET", `${BASE}/${REQUEST_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: REQUEST_ID, events: [] });
      expect(admin.get).toHaveBeenCalledWith(REQUEST_ID);
    });

    it("previews a resolution as a dry run (200) and never resolves", async () => {
      const res = await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve/preview`, previewBody);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ dryRun: true });
      expect(admin.previewResolution).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining(previewBody));
      expect(admin.resolve).not.toHaveBeenCalled();
    });

    it("previews a NO_CHANGE outcome with no businesses", async () => {
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve/preview`, { outcome: "NO_CHANGE" })).status).toBe(200);
      expect(admin.previewResolution).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({ outcome: "NO_CHANGE" }));
    });

    it("resolves a disconnect with 200 and records the authenticated platform admin as the actor, never anything from the body", async () => {
      const res = await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, disconnectBody);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requestId: REQUEST_ID, status: "COMPLETED" });
      expect(admin.resolve).toHaveBeenCalledTimes(1);
      expect(admin.resolve).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining(disconnectBody), users.admin.id);
    });

    it("resolves a no-change closure with its documented reason", async () => {
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, noChangeBody)).status).toBe(200);
      expect(admin.resolve).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining(noChangeBody), users.admin.id);
    });

    it("surfaces the service's not-found and conflict answers unchanged", async () => {
      admin.get.mockRejectedValueOnce(new NotFoundException("Request not found."));
      admin.resolve.mockRejectedValueOnce(new ConflictException("This event is already COMPLETED."));

      expect((await asAdmin("GET", `${BASE}/${REQUEST_ID}`)).status).toBe(404);
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, disconnectBody)).status).toBe(409);
    });

    it("rate limits the destructive resolve route to 5 requests a minute", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, disconnectBody)).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      expect(admin.resolve).toHaveBeenCalledTimes(5);
    });
  });
});
