import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DEFAULT_WEB_ORIGIN, parseWebOrigins, primaryWebOrigin, resolveCors } from "./cors.helper";

const APEX = "https://relayshift.in";
const WWW = "https://www.relayshift.in";
const RAILWAY_VALUE = `${APEX},${WWW}`;

describe("parseWebOrigins — WEB_ORIGIN as a list of exact origins", () => {
  it("accepts a comma-separated list, keeping its order (the first entry is the primary origin)", () => {
    expect(parseWebOrigins(RAILWAY_VALUE)).toEqual({ origins: [APEX, WWW], ignored: [] });
    expect(primaryWebOrigin(RAILWAY_VALUE)).toBe(APEX);
  });

  it("still accepts a single origin", () => {
    expect(parseWebOrigins(APEX).origins).toEqual([APEX]);
  });

  it("tolerates spaces, trailing slashes, upper-case hosts and duplicates", () => {
    expect(parseWebOrigins(` ${APEX}/ , HTTPS://WWW.RELAYSHIFT.IN ,${APEX}`).origins).toEqual([APEX, WWW]);
  });

  it("keeps an explicit port as part of the origin", () => {
    expect(parseWebOrigins("http://localhost:3000,https://relayshift.in:8443").origins).toEqual(["http://localhost:3000", "https://relayshift.in:8443"]);
  });

  it("falls back to local development only when WEB_ORIGIN is not set at all", () => {
    expect(parseWebOrigins(undefined)).toEqual({ origins: [DEFAULT_WEB_ORIGIN], ignored: [] });
    expect(primaryWebOrigin(undefined)).toBe("http://localhost:3000");
  });

  it("never adds the development origin on top of a configured value", () => {
    expect(parseWebOrigins(RAILWAY_VALUE).origins).not.toContain(DEFAULT_WEB_ORIGIN);
  });

  it.each([
    ["a wildcard", "*"],
    ["a bare hostname", "relayshift.in"],
    ["host:port without a scheme", "localhost:3000"],
    ["another scheme", "ftp://relayshift.in"],
    ["garbage", "not a url"],
  ])("rejects %s instead of allowing it", (_label, value) => {
    expect(parseWebOrigins(`${APEX},${value}`)).toEqual({ origins: [APEX], ignored: [value] });
  });

  it("allows nothing — rather than falling back to anything — when the value has no valid origin", () => {
    expect(parseWebOrigins("").origins).toEqual([]);
    expect(parseWebOrigins("*").origins).toEqual([]);
    expect(resolveCors("*").options.origin).toBe(false);
    expect(primaryWebOrigin("*")).toBe("http://localhost:3000"); // only used to build a redirect link, never to allow a browser origin
  });

  it("always enables credentials together with an explicit origin list, never with a wildcard", () => {
    const { options } = resolveCors(RAILWAY_VALUE);
    expect(options).toEqual({ origin: [APEX, WWW], credentials: true });
    expect(options.origin).not.toBe("*");
    expect(JSON.stringify(options.origin)).not.toContain("*");
  });
});

// The real Nest application with the real `cors` middleware that app.enableCors() installs — exactly what main.ts does.
@Controller("ping")
class PingController {
  @Get() ping() { return { ok: true }; }
}

describe("API CORS behaviour (real Nest app, real preflight and requests)", () => {
  const apps: INestApplication[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

  async function appWith(webOrigin: string | undefined) {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    const app = moduleRef.createNestApplication();
    app.enableCors(resolveCors(webOrigin).options);
    await app.listen(0, "127.0.0.1");
    apps.push(app);
    return (app.getHttpServer().address() as AddressInfo).port;
  }

  const send = (port: number, method: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/ping", method, headers }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); });
      req.on("error", reject);
      req.end();
    });

  const preflight = (port: number, origin: string) =>
    send(port, "OPTIONS", { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" });
  const get = (port: number, origin?: string) => send(port, "GET", origin ? { Origin: origin } : {});

  describe.each([APEX, WWW])("allowed production origin %s", (origin) => {
    it("passes the preflight with that exact origin, credentials, methods and the requested headers", async () => {
      const res = await preflight(await appWith(RAILWAY_VALUE), origin);
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(res.headers["access-control-allow-methods"])).toContain("POST");
      expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toEqual(expect.stringContaining("authorization"));
      expect(String(res.headers.vary)).toContain("Origin"); // responses differ per origin, so caches must key on it
    });

    it("gets the same headers on the actual request", async () => {
      const res = await get(await appWith(RAILWAY_VALUE), origin);
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });
  });

  it.each([
    "https://evil.example",
    "https://relayshift.in.evil.example", // suffix trick
    "https://evilrelayshift.in", // prefix trick
    "https://sub.relayshift.in", // sibling subdomain
    "http://relayshift.in", // wrong scheme
    "http://www.relayshift.in",
    "https://relayshift.in:8443", // wrong port
    "null",
  ])("rejects the unrelated origin %s — preflight and request both carry no Allow-Origin", async (origin) => {
    const port = await appWith(RAILWAY_VALUE);
    const pre = await preflight(port, origin);
    expect(pre.status).toBe(204); // the browser, not the server, enforces the refusal…
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined(); // …because this header is missing (the cors library still sends Allow-Credentials, which grants nothing without it)
    const res = await get(port, origin);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never answers with a wildcard, whatever the origin or configuration", async () => {
    for (const value of [RAILWAY_VALUE, `*,${APEX}`, "*", undefined]) {
      const port = await appWith(value);
      for (const origin of [APEX, WWW, "https://evil.example", "http://localhost:3000"]) {
        expect(`${(await preflight(port, origin)).headers["access-control-allow-origin"]}`).not.toBe("*");
        expect(`${(await get(port, origin)).headers["access-control-allow-origin"]}`).not.toBe("*");
      }
    }
  });

  it("reproduces the reported failure when only the apex is configured: www gets a 204 without Allow-Origin", async () => {
    const res = await preflight(await appWith(APEX), WWW);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps local development working when WEB_ORIGIN is unset, and does not open production domains then", async () => {
    const port = await appWith(undefined);
    expect((await preflight(port, "http://localhost:3000")).headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect((await preflight(port, APEX)).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows nothing cross-origin when WEB_ORIGIN has no valid origin", async () => {
    const port = await appWith("*");
    expect((await preflight(port, APEX)).headers["access-control-allow-origin"]).toBeUndefined();
    expect((await get(port, WWW)).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not affect requests that send no Origin header (server-to-server calls, webhooks, curl)", async () => {
    const res = await get(await appWith(RAILWAY_VALUE));
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
