import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Business, Order } from "@prisma/client";
import { RazorpayService } from "./razorpay.service";
import { encryptSecret } from "../../common/crypto.helper";

type BusinessPick = Pick<Business, "id" | "razorpayKeyId" | "razorpayKeySecretEncrypted" | "name">;

describe("RazorpayService", () => {
  let service: RazorpayService;
  const ORIGINAL_ENV = { ...process.env };
  const ENCRYPTION_KEY = "1".repeat(64);

  beforeEach(() => {
    service = new RazorpayService();
    process.env = { ...ORIGINAL_ENV, CREDENTIALS_ENCRYPTION_KEY: ENCRYPTION_KEY };
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("verifyWebhookSignature", () => {
    it("returns 'skipped' when no webhook secret is configured anywhere", () => {
      const business = { razorpayWebhookSecretEncrypted: null };
      const body = Buffer.from("{}");
      expect(service.verifyWebhookSignature(body, "anything", business)).toBe("skipped");
    });

    it("falls back to the env var secret when the business hasn't configured its own", () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = "env-secret";
      const business = { razorpayWebhookSecretEncrypted: null };
      const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));
      const signature = createHmac("sha256", "env-secret").update(body).digest("hex");
      expect(service.verifyWebhookSignature(body, signature, business)).toBe("valid");
    });

    it("prefers the business's own encrypted secret over the env fallback", () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = "env-secret";
      const business = { razorpayWebhookSecretEncrypted: encryptSecret("business-secret") };
      const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));

      const signedWithBusinessSecret = createHmac("sha256", "business-secret").update(body).digest("hex");
      expect(service.verifyWebhookSignature(body, signedWithBusinessSecret, business)).toBe("valid");

      const signedWithEnvSecret = createHmac("sha256", "env-secret").update(body).digest("hex");
      expect(service.verifyWebhookSignature(body, signedWithEnvSecret, business)).toBe("invalid");
    });
  });

  describe("createPaymentLink", () => {
    const business: BusinessPick = { id: "biz1", razorpayKeyId: "rzp_test_key", razorpayKeySecretEncrypted: null, name: "Prajwal Studio" };
    const order: Pick<Order, "id" | "total" | "currency"> = { id: "order1", total: new Prisma.Decimal("2299.00"), currency: "INR" };
    const customer = { name: "Test Customer", phone: "+911234567890" };

    it("returns null (without calling fetch) when no credentials are configured", async () => {
      const fetchSpy = jest.spyOn(global, "fetch");
      const unconfigured: BusinessPick = { id: "biz1", razorpayKeyId: null, razorpayKeySecretEncrypted: null, name: "No Razorpay" };
      const result = await service.createPaymentLink(unconfigured, order, customer);
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("falls back to env credentials when the business hasn't configured its own key/secret", async () => {
      process.env.RAZORPAY_KEY_ID = "env_key_id";
      process.env.RAZORPAY_KEY_SECRET = "env_key_secret";
      const noKeyBusiness: BusinessPick = { id: "biz1", razorpayKeyId: null, razorpayKeySecretEncrypted: null, name: "Env Fallback Biz" };
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ id: "plink_env", short_url: "https://rzp.io/env" }),
      } as Response);

      const result = await service.createPaymentLink(noKeyBusiness, order, customer);
      expect(result).toEqual({ id: "plink_env", shortUrl: "https://rzp.io/env" });
    });

    it("creates a payment link with the correct amount (in paise), auth header, and reference id", async () => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ id: "plink_abc", short_url: "https://rzp.io/abc" }),
      } as Response);
      process.env.RAZORPAY_KEY_SECRET = "env_secret_for_this_business"; // business has keyId but no secret -> falls back for secret only

      const result = await service.createPaymentLink(business, order, customer);

      expect(result).toEqual({ id: "plink_abc", shortUrl: "https://rzp.io/abc" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.razorpay.com/v1/payment_links");
      const expectedAuth = `Basic ${Buffer.from("rzp_test_key:env_secret_for_this_business").toString("base64")}`;
      expect((options?.headers as Record<string, string>).Authorization).toBe(expectedAuth);

      const body = JSON.parse(options?.body as string);
      expect(body.amount).toBe(229900); // ₹2299.00 -> 229900 paise
      expect(body.currency).toBe("INR");
      expect(body.reference_id).toBe("order1");
      expect(body.notify).toEqual({ sms: false, email: false });
      expect(body.customer.name).toBe("Test Customer");
      expect(body.customer.contact).toBe("+911234567890");
    });

    it("returns null (and doesn't throw) when Razorpay responds with a non-OK status", async () => {
      process.env.RAZORPAY_KEY_SECRET = "secret";
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        json: async () => ({ error: { description: "bad request" } }),
      } as Response);
      await expect(service.createPaymentLink(business, order, customer)).resolves.toBeNull();
    });

    it("returns null (and doesn't throw) when the fetch call itself fails", async () => {
      process.env.RAZORPAY_KEY_SECRET = "secret";
      jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
      await expect(service.createPaymentLink(business, order, customer)).resolves.toBeNull();
    });
  });
});
