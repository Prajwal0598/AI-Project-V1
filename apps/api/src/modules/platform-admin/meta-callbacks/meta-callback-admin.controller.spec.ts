import "reflect-metadata";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ConflictException, INestApplication, NotFoundException, ValidationPipe } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { MetaCallbackAdminController } from "./meta-callback-admin.controller";
import { MetaCallbackAdminService } from "./meta-callback-admin.service";
import { PrismaService } from "../../../database/prisma.service";
import { PlatformAdminGuard } from "../../../common/platform-admin.guard";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { JwtStrategy } from "../../auth/jwt.strategy";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";

// Real JwtAuthGuard + JwtStrategy + PlatformAdminGuard + ThrottlerGuard + ValidationPipe, wired as in app.module.ts and main.ts.
// Only the database user lookup and the admin service are stubbed.

const SECRET = "controller-spec-jwt-secret-not-real";
const REQUEST_ID = "ckrequest1234567890abc";
const BUSINESS_ID = "ckbusiness1234567890ab";
const BASE = "/api/platform/meta-callbacks";

const users: Record<string, Record<string, unknown>> = {
  admin: { id: "user-platform-admin", businessId: "biz-ops", role: "MEMBER", isPlatformAdmin: true },
  owner: { id: "user-merchant-owner", businessId: "biz-1", role: "OWNER", isPlatformAdmin: false },
  merchantAdmin: { id: "user-merchant-admin", businessId: "biz-2", role: "ADMIN", isPlatformAdmin: false },
  member: { id: "user-merchant-member", businessId: "biz-3", role: "MEMBER", isPlatformAdmin: false },
};

const previewBody = { outcome: "COMPLETED", businessIds: [BUSINESS_ID] };
const resolveBody = { outcome: "COMPLETED", businessIds: [BUSINESS_ID], verificationMethod: "MERCHANT_WRITTEN_CONFIRMATION", resolutionReference: "TICKET-101", confirm: "RESOLVE abcdef" };

const routes: Array<[string, string, string, unknown]> = [
  ["list", "GET", BASE, undefined],
  ["detail", "GET", `${BASE}/${REQUEST_ID}`, undefined],
  ["preview", "POST", `${BASE}/${REQUEST_ID}/resolve/preview`, previewBody],
  ["resolve", "POST", `${BASE}/${REQUEST_ID}/resolve`, resolveBody],
];

describe("MetaCallbackAdminController", () => {
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
      controllers: [MetaCallbackAdminController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: MetaCallbackAdminService, useValue: admin },
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
    it("is guarded by PlatformAdminGuard, never public, and mounted under platform/meta-callbacks", () => {
      expect(Reflect.getMetadata("__guards__", MetaCallbackAdminController)).toContain(PlatformAdminGuard);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetaCallbackAdminController)).toBeUndefined();
      expect(Reflect.getMetadata("path", MetaCallbackAdminController)).toBe("platform/meta-callbacks");
    });

    it("exposes exactly list, detail, preview and resolve, each rate limited, and nothing that could delete a request", () => {
      const proto = MetaCallbackAdminController.prototype;
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
        const res = await send(method, path, { authorization, json: body });
        expect(res.status).toBe(401);
      }
      expectServiceUntouched();
    });

    it("rejects a token signed with another secret, even when it names a real platform admin", async () => {
      const forged = new JwtService({ secret: "someone-elses-secret" }).sign({ sub: users.admin.id });
      const res = await send("POST", `${BASE}/${REQUEST_ID}/resolve`, { authorization: `Bearer ${forged}`, json: resolveBody });
      expect(res.status).toBe(401);
      expectServiceUntouched();
    });
  });

  describe("insufficient permissions", () => {
    it.each(routes)("%s: answers 403 for every merchant role, and never reaches the service", async (_name, method, path, body) => {
      for (const key of ["owner", "merchantAdmin", "member"]) {
        const res = await send(method, path, { authorization: `Bearer ${tokenFor(key)}`, json: body });
        expect(res.status).toBe(403);
      }
      expectServiceUntouched();
    });

    it("decides from the stored account, not from claims in the token", async () => {
      const claimed = jwt.sign({ sub: users.owner.id, isPlatformAdmin: true, role: "PLATFORM_ADMIN" });
      const res = await send("POST", `${BASE}/${REQUEST_ID}/resolve`, { authorization: `Bearer ${claimed}`, json: resolveBody });
      expect(res.status).toBe(403);
      expectServiceUntouched();
    });
  });

  describe("validation errors", () => {
    const longId = (n: number) => `ckbusiness${String(n).padStart(10, "0")}`;

    it.each([
      ["an unknown status", "?status=BOGUS"],
      ["an unknown kind", "?kind=EVERYTHING"],
      ["take below 1", "?take=0"],
      ["take above 100", "?take=101"],
      ["a non-numeric take", "?take=abc"],
      ["a fractional take", "?take=1.5"],
      ["an unknown query parameter", "?businessId=biz-1"],
    ])("list rejects %s with 400", async (_label, query) => {
      const res = await asAdmin("GET", `${BASE}${query}`);
      expect(res.status).toBe(400);
      expectServiceUntouched();
    });

    it.each([
      ["a missing body", undefined],
      ["an empty body", {}],
      ["an unknown outcome", { outcome: "DELETE_EVERYTHING" }],
      ["businessIds that is not an array", { outcome: "COMPLETED", businessIds: BUSINESS_ID }],
      ["a path-like business id", { outcome: "COMPLETED", businessIds: ["../etc/passwd"] }],
      ["a non-string business id", { outcome: "COMPLETED", businessIds: [12345] }],
      ["more than 10 business ids", { outcome: "COMPLETED", businessIds: Array.from({ length: 11 }, (_, i) => longId(i)) }],
      ["duplicate business ids", { outcome: "COMPLETED", businessIds: [BUSINESS_ID, BUSINESS_ID] }],
      ["an unexpected property", { ...previewBody, force: true }],
    ])("preview rejects %s with 400", async (_label, body) => {
      const res = await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve/preview`, body);
      expect(res.status).toBe(400);
      expectServiceUntouched();
    });

    const without = (key: string) => Object.fromEntries(Object.entries(resolveBody).filter(([k]) => k !== key));
    it.each([
      ["a missing body", undefined],
      ["a missing verificationMethod", without("verificationMethod")],
      ["an unknown verificationMethod", { ...resolveBody, verificationMethod: "TRUST_ME" }],
      ["a missing resolutionReference", without("resolutionReference")],
      ["a too-short resolutionReference", { ...resolveBody, resolutionReference: "x" }],
      ["a resolutionReference holding an email address", { ...resolveBody, resolutionReference: "jane@example.com" }],
      ["a resolutionReference with spaces", { ...resolveBody, resolutionReference: "ticket 101" }],
      ["a resolutionReference over 64 characters", { ...resolveBody, resolutionReference: "T".repeat(65) }],
      ["a missing confirm", without("confirm")],
      ["an empty confirm", { ...resolveBody, confirm: "" }],
      ["a caller-supplied resolvedByUserId", { ...resolveBody, resolvedByUserId: "someone-else" }],
      ["a caller-supplied status", { ...resolveBody, status: "COMPLETED" }],
      ["a path-like business id", { ...resolveBody, businessIds: ["../x"] }],
    ])("resolve rejects %s with 400", async (_label, body) => {
      const res = await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, body);
      expect(res.status).toBe(400);
      expectServiceUntouched();
    });
  });

  describe("successful requests", () => {
    it("lists with the validated, typed query", async () => {
      const res = await asAdmin("GET", `${BASE}?status=PENDING_REVIEW&kind=DATA_DELETION&take=10`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: REQUEST_ID }]);
      expect(admin.list).toHaveBeenCalledWith(expect.objectContaining({ status: "PENDING_REVIEW", kind: "DATA_DELETION", take: 10 }));
    });

    it("lists with no filters", async () => {
      expect((await asAdmin("GET", BASE)).status).toBe(200);
      expect(admin.list).toHaveBeenCalledTimes(1);
    });

    it("returns one request with its audit history", async () => {
      const res = await asAdmin("GET", `${BASE}/${REQUEST_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: REQUEST_ID, events: [] });
      expect(admin.get).toHaveBeenCalledWith(REQUEST_ID);
    });

    it("previews a resolution as a dry run (200)", async () => {
      const res = await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve/preview`, previewBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ dryRun: true });
      expect(admin.previewResolution).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining(previewBody));
      expect(admin.resolve).not.toHaveBeenCalled();
    });

    it("resolves with 200 and records the authenticated platform admin as the actor, never anything from the body", async () => {
      const res = await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, resolveBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requestId: REQUEST_ID, status: "COMPLETED" });
      expect(admin.resolve).toHaveBeenCalledTimes(1);
      expect(admin.resolve).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining(resolveBody), users.admin.id);
    });

    it("passes a NO_DATA_HELD resolution through with no businesses", async () => {
      const body = { outcome: "NO_DATA_HELD", verificationMethod: "RECORDS_SEARCH_NO_MATCH", resolutionReference: "TICKET-102", confirm: "RESOLVE abcdef" };
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, body)).status).toBe(200);
      expect(admin.resolve).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining(body), users.admin.id);
    });

    it("surfaces the service's not-found and conflict answers unchanged", async () => {
      admin.get.mockRejectedValueOnce(new NotFoundException("Request not found."));
      admin.resolve.mockRejectedValueOnce(new ConflictException("This request has already been resolved."));

      expect((await asAdmin("GET", `${BASE}/${REQUEST_ID}`)).status).toBe(404);
      expect((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, resolveBody)).status).toBe(409);
    });

    it("rate limits the destructive resolve route to 5 requests a minute", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await asAdmin("POST", `${BASE}/${REQUEST_ID}/resolve`, resolveBody)).status);

      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      expect(admin.resolve).toHaveBeenCalledTimes(5);
    });
  });
});
