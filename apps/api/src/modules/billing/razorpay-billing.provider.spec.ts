import { RazorpayBillingProvider } from "./razorpay-billing.provider";

describe("RazorpayBillingProvider", () => {
  let provider: RazorpayBillingProvider;
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.RELAY_BILLING_RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RELAY_BILLING_RAZORPAY_KEY_SECRET = "test_secret";
    provider = new RazorpayBillingProvider();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("getPublicKeyId returns the configured key id", () => {
    expect(provider.getPublicKeyId()).toBe("rzp_test_key");
  });

  it("createPlan posts the correct Razorpay plan shape and returns the plan id", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "plan_abc123" }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const id = await provider.createPlan({ name: "Relay Pro", amount: 299900, currency: "INR", billingInterval: "monthly" });

    expect(id).toBe("plan_abc123");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/plans");
    const body = JSON.parse(options.body);
    expect(body).toEqual({ period: "monthly", interval: 1, item: { name: "Relay Pro", amount: 299900, currency: "INR" } });
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from("rzp_test_key:test_secret").toString("base64")}`);
  });

  it("createSubscription includes start_at only when a trial end date is given", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "sub_abc123", short_url: null }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const trialEnd = new Date("2026-11-01T00:00:00Z");
    await provider.createSubscription({ razorpayPlanId: "plan_abc123", businessId: "biz1", startAt: trialEnd });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.plan_id).toBe("plan_abc123");
    expect(body.customer_notify).toBe(true);
    expect(body.start_at).toBe(Math.floor(trialEnd.getTime() / 1000));
    expect(body.notes).toEqual({ businessId: "biz1" });
  });

  it("createSubscription omits start_at when there's no trial", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "sub_abc123", short_url: null }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await provider.createSubscription({ razorpayPlanId: "plan_abc123", businessId: "biz1" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.start_at).toBeUndefined();
  });

  it("cancelSubscription passes cancel_at_cycle_end through exactly", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await provider.cancelSubscription("sub_abc123", true);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.razorpay.com/v1/subscriptions/sub_abc123/cancel");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ cancel_at_cycle_end: true });
  });

  it("throws (never silently swallows) when the Razorpay API call fails — billing errors must surface, unlike the customer-order payment-link fallback", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { description: "bad request" } }) }) as unknown as typeof fetch;
    await expect(provider.createPlan({ name: "x", amount: 100, currency: "INR", billingInterval: "monthly" })).rejects.toThrow();
  });

  it("throws if Relay's own Razorpay credentials aren't configured", async () => {
    delete process.env.RELAY_BILLING_RAZORPAY_KEY_ID;
    delete process.env.RELAY_BILLING_RAZORPAY_KEY_SECRET;
    global.fetch = jest.fn() as unknown as typeof fetch;
    await expect(provider.createPlan({ name: "x", amount: 100, currency: "INR", billingInterval: "monthly" })).rejects.toThrow();
  });
});
