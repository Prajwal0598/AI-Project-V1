import { buildOrderKey, stripHallucinatedLinks } from "./ai.service";

describe("buildOrderKey", () => {
  it("builds a stable key from items, address, and payment method", () => {
    const key = buildOrderKey([{ productName: "Blue Shirt", quantity: 2 }], "123 Main St", "UPI");
    expect(key).toBe("blue shirtx2|123 main st|upi");
  });

  it("is order-independent for the items list (sorted)", () => {
    const a = buildOrderKey(
      [{ productName: "Shirt", quantity: 1 }, { productName: "Jeans", quantity: 2 }],
      "Addr", "COD",
    );
    const b = buildOrderKey(
      [{ productName: "Jeans", quantity: 2 }, { productName: "Shirt", quantity: 1 }],
      "Addr", "COD",
    );
    expect(a).toBe(b);
  });

  it("is case- and whitespace-insensitive for product names, address, and payment method", () => {
    const a = buildOrderKey([{ productName: "  Blue Shirt  ", quantity: 1 }], "  123 Main St  ", "  UPI  ");
    const b = buildOrderKey([{ productName: "blue shirt", quantity: 1 }], "123 main st", "upi");
    expect(a).toBe(b);
  });

  it("produces different keys for different quantities of the same product", () => {
    const a = buildOrderKey([{ productName: "Shirt", quantity: 1 }], "Addr", "COD");
    const b = buildOrderKey([{ productName: "Shirt", quantity: 2 }], "Addr", "COD");
    expect(a).not.toBe(b);
  });
});

describe("stripHallucinatedLinks", () => {
  it("removes a line containing a URL, keeping surrounding lines intact", () => {
    const reply = "Thanks for your order!\nTrack it here: https://example.com/track/123\nLet us know if you need anything.";
    const result = stripHallucinatedLinks(reply);
    expect(result).not.toContain("http");
    expect(result).toContain("Thanks for your order!");
    expect(result).toContain("Let us know if you need anything.");
  });

  it("leaves a reply with no URL untouched", () => {
    const reply = "Your order has been placed and will be delivered soon.";
    expect(stripHallucinatedLinks(reply)).toBe(reply);
  });

  it("collapses extra blank lines left behind after stripping", () => {
    const reply = "Line one.\nhttps://bad-link.com/pay\nLine two.";
    const result = stripHallucinatedLinks(reply);
    expect(result).not.toMatch(/\n{3,}/);
  });
});
