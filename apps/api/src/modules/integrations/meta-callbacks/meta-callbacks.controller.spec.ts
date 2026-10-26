import "reflect-metadata";
import { createHmac } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, Get, INestApplication, ValidationPipe } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { MetaCallbacksController } from "./meta-callbacks.controller";
import { MetaCallbacksService } from "./meta-callbacks.service";
import { PrismaService } from "../../../database/prisma.service";
import { MetaGraphApiService } from "../whatsapp-embedded-signup/meta-graph-api.service";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";

const APP_SECRET = "test-app-secret-not-real";
const USER = "1000000000000001";
const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");
function sign(payload: Record<string, unknown>, secret = APP_SECRET): string {
  const encoded = b64u(JSON.stringify(payload));
  return `${b64u(createHmac("sha256", secret).update(encoded).digest())}.${encoded}`;
}
const signed = (secret = APP_SECRET) => sign({ algorithm: "HMAC-SHA256", issued_at: 1_790_000_000, user_id: USER }, secret);

@Controller("private-ping")
class PrivateController {
  @Get() ping() { return { ok: true }; }
}

describe("MetaCallbacksController — route metadata", () => {
  it("is public (no RelayShift login) and mounted under integrations/meta", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetaCallbacksController)).toBe(true);
    expect(Reflect.getMetadata("path", MetaCallbacksController)).toBe("integrations/meta");
  });

  it("exposes exactly POST deauthorize, POST data-deletion and GET data-deletion/status/:confirmationCode", () => {
    const proto = MetaCallbacksController.prototype;
    const GET = 0, POST = 1;
    expect([Reflect.getMetadata("method", proto.deauthorize), Reflect.getMetadata("path", proto.deauthorize)]).toEqual([POST, "deauthorize"]);
    expect([Reflect.getMetadata("method", proto.dataDeletion), Reflect.getMetadata("path", proto.dataDeletion)]).toEqual([POST, "data-deletion"]);
    expect([Reflect.getMetadata("method", proto.deletionStatus), Reflect.getMetadata("path", proto.deletionStatus)]).toEqual([GET, "data-deletion/status/:confirmationCode"]);
    expect(Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor").sort()).toEqual(["dataDeletion", "deauthorize", "deletionStatus"]);
  });

  it("answers Meta's POSTs with 200 and rate limits every route", () => {
    const proto = MetaCallbacksController.prototype;
    expect(Reflect.getMetadata("__httpCode__", proto.deauthorize)).toBe(200);
    expect(Reflect.getMetadata("__httpCode__", proto.dataDeletion)).toBe(200);
    for (const handler of [proto.deauthorize, proto.dataDeletion, proto.deletionStatus]) {
      expect(Reflect.getMetadataKeys(handler).some((k) => String(k).startsWith("THROTTLER:LIMIT"))).toBe(true);
    }
  });
});

describe("Meta callbacks over HTTP (real Nest app, real global guards and validation, as in main.ts)", () => {
  const ORIGINAL_ENV = { ...process.env };
  let app: INestApplication;
  let port: number;
  let prisma: any;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", WHATSAPP_APP_SECRET: APP_SECRET, CREDENTIALS_ENCRYPTION_KEY: "1".repeat(64), WEB_ORIGIN: "https://relayshift.in,https://www.relayshift.in" };
    prisma = {
      metaCallbackRequest: { create: jest.fn().mockResolvedValue({ id: "req1" }), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 0 }), findUnique: jest.fn().mockResolvedValue(null) },
      metaUserLink: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn(), deleteMany: jest.fn() },
      metaCallbackEvent: { create: jest.fn().mockResolvedValue({}) },
      business: { findUnique: jest.fn(), updateMany: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [MetaCallbacksController, PrivateController],
      providers: [
        MetaCallbacksService,
        { provide: PrismaService, useValue: prisma },
        { provide: MetaGraphApiService, useValue: { deauthorize: jest.fn() } },
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

  const send = (method: string, path: string, opts: { form?: Record<string, string>; json?: unknown } = {}) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const payload = opts.form ? new URLSearchParams(opts.form).toString() : opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
      const headers: Record<string, string> = {};
      if (opts.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      if (payload !== undefined) headers["Content-Length"] = String(Buffer.byteLength(payload));
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  it("the global login guard is active for ordinary routes, so the callbacks' openness is deliberate", async () => {
    const res = await send("GET", "/api/private-ping");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  describe("POST /api/integrations/meta/deauthorize", () => {
    it("accepts Meta's form-encoded signed_request with no Authorization header and answers 200 JSON", async () => {
      const res = await send("POST", "/api/integrations/meta/deauthorize", { form: { signed_request: signed() } });
      expect(res.status).toBe(200);
      expect(res.type).toContain("application/json");
      expect(JSON.parse(res.body)).toEqual({ success: true });
    });

    it("also accepts a JSON body", async () => {
      const res = await send("POST", "/api/integrations/meta/deauthorize", { json: { signed_request: signed() } });
      expect(res.status).toBe(200);
    });

    it("tolerates extra form fields (the global whitelist validation does not reject them)", async () => {
      const res = await send("POST", "/api/integrations/meta/deauthorize", { form: { signed_request: signed(), unexpected: "field" } });
      expect(res.status).toBe(200);
    });

    it("rejects a request signed with another secret with 403 and a generic body that echoes nothing", async () => {
      const forged = signed("another-apps-secret");
      const res = await send("POST", "/api/integrations/meta/deauthorize", { form: { signed_request: forged } });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain(forged);
      expect(res.body).not.toContain(USER);
      expect(prisma.metaCallbackRequest.create).not.toHaveBeenCalled();
    });

    it("rejects a missing signed_request with 400", async () => {
      expect((await send("POST", "/api/integrations/meta/deauthorize", { form: {} })).status).toBe(400);
      expect((await send("POST", "/api/integrations/meta/deauthorize")).status).toBe(400);
    });

    it("is POST only", async () => {
      expect((await send("GET", "/api/integrations/meta/deauthorize")).status).toBe(404);
    });
  });

  describe("POST /api/integrations/meta/data-deletion", () => {
    it("answers with exactly { url, confirmation_code } as JSON, the url pointing at the public status page", async () => {
      const res = await send("POST", "/api/integrations/meta/data-deletion", { form: { signed_request: signed() } });

      expect(res.status).toBe(200);
      expect(res.type).toContain("application/json");
      const body = JSON.parse(res.body);
      expect(Object.keys(body).sort()).toEqual(["confirmation_code", "url"]);
      expect(body.confirmation_code).toMatch(/^[a-f0-9]{32}$/);
      expect(body.url).toBe(`https://relayshift.in/data-deletion/status?code=${body.confirmation_code}`);
    });

    it("rejects an invalid signature with 403 and creates no request", async () => {
      const res = await send("POST", "/api/integrations/meta/data-deletion", { form: { signed_request: signed("another-apps-secret") } });
      expect(res.status).toBe(403);
      expect(prisma.metaCallbackRequest.create).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/integrations/meta/data-deletion/status/:confirmationCode", () => {
    const code = "c".repeat(32);

    it("is public and returns the human-readable status as JSON", async () => {
      prisma.metaCallbackRequest.findUnique.mockResolvedValue({ confirmationCode: code, kind: "DATA_DELETION", status: "PENDING_REVIEW", createdAt: new Date("2026-10-26T00:00:00Z"), completedAt: null });

      const res = await send("GET", `/api/integrations/meta/data-deletion/status/${code}`);

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ confirmationCode: code, status: "PENDING_REVIEW", completedAt: null });
      expect(res.body).not.toContain(USER);
    });

    it("answers 404 for an unknown or malformed code", async () => {
      expect((await send("GET", `/api/integrations/meta/data-deletion/status/${code}`)).status).toBe(404);
      expect((await send("GET", "/api/integrations/meta/data-deletion/status/not-a-code")).status).toBe(404);
    });

    it("is read-only: POST is not routed", async () => {
      expect((await send("POST", `/api/integrations/meta/data-deletion/status/${code}`)).status).toBe(404);
    });
  });
});
