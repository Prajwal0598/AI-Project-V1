import { MetaGraphApiService } from "./meta-graph-api.service";
import { META_GRAPH_API_VERSION } from "../../../common/meta-graph";

const BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

describe("MetaGraphApiService request construction", () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_FETCH = global.fetch;
  const fetchMock = jest.fn();
  let service: MetaGraphApiService;

  const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, META_APP_ID: "app123", WHATSAPP_APP_SECRET: "secret456" };
    fetchMock.mockReset().mockResolvedValue(ok({ access_token: "tok", id: "1234567890", display_phone_number: "+91", success: true, data: { app_id: "app123", type: "USER", user_id: "1234567890", is_valid: true } }));
    (global as any).fetch = fetchMock;
    service = new MetaGraphApiService();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    global.fetch = ORIGINAL_FETCH;
  });

  it("pins a supported Graph version, never v19.0 or v21.0", () => {
    expect(META_GRAPH_API_VERSION).toBe("v26.0");
    expect(BASE).toBe("https://graph.facebook.com/v26.0");
  });

  it("builds every request on the pinned version", async () => {
    await service.exchangeCodeForToken("code1");
    await service.subscribeAppToWaba("waba1", "BUSINESS_TOKEN");
    await service.registerPhoneNumber("phone1", "BUSINESS_TOKEN");
    await service.getPhoneNumberDetails("phone1", "BUSINESS_TOKEN");
    await service.getTokenIdentity("BUSINESS_TOKEN");
    await service.debugToken("USER_TOKEN");
    await service.deauthorize("waba1", "BUSINESS_TOKEN");

    const calls = fetchMock.mock.calls as [string, RequestInit?][];
    expect(calls).toHaveLength(7);
    for (const [url] of calls) {
      expect(url.startsWith(`${BASE}/`)).toBe(true);
      expect(url).not.toMatch(/v19\.0|v21\.0/);
    }
    const urls = calls.map(([url]) => url);
    expect(urls).toContain(`${BASE}/waba1/subscribed_apps`);
    expect(urls).toContain(`${BASE}/phone1/register`);
    expect(urls).toContain(`${BASE}/me?fields=id,client_business_id`);
    expect(urls.some((u) => u.startsWith(`${BASE}/oauth/access_token?`) && u.includes("code=code1"))).toBe(true);
    expect(urls.some((u) => u.startsWith(`${BASE}/debug_token?`) && u.includes("input_token=USER_TOKEN"))).toBe(true);
  });

  it("sends business tokens in the Authorization header, never in the URL", async () => {
    await service.getTokenIdentity("BUSINESS_TOKEN");
    await service.subscribeAppToWaba("waba1", "BUSINESS_TOKEN");
    for (const [url, init] of fetchMock.mock.calls as [string, RequestInit?][]) {
      expect(url).not.toContain("BUSINESS_TOKEN");
      expect(JSON.stringify(init?.headers)).toContain("Bearer BUSINESS_TOKEN");
    }
  });
});
