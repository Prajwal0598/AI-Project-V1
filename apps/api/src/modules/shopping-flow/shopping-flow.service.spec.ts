import { parseSearchQuery, fmtMoney, formatVariantLabel } from "./shopping-flow.service";

describe("parseSearchQuery", () => {
  it("extracts a max price from 'under'", () => {
    expect(parseSearchQuery("black shoes under 2500")).toEqual({
      maxPrice: 2500,
      minPrice: undefined,
      keywords: ["black", "shoes"],
    });
  });

  it("extracts a max price from 'below' with a currency symbol", () => {
    expect(parseSearchQuery("jackets below ₹1000")).toEqual({
      maxPrice: 1000,
      minPrice: undefined,
      keywords: ["jackets"],
    });
  });

  it("extracts a min price from 'above'/'over'", () => {
    expect(parseSearchQuery("jackets above 1000")).toEqual({
      maxPrice: undefined,
      minPrice: 1000,
      keywords: ["jackets"],
    });
  });

  it("extracts both a min and max price", () => {
    const result = parseSearchQuery("shirts over 500 under 2000");
    expect(result.minPrice).toBe(500);
    expect(result.maxPrice).toBe(2000);
    expect(result.keywords).toEqual(["shirts"]);
  });

  it("strips stopwords from keywords", () => {
    expect(parseSearchQuery("do you have any blue jeans")).toEqual({
      maxPrice: undefined,
      minPrice: undefined,
      keywords: ["blue", "jeans"],
    });
  });

  it("returns no filters/keywords for an empty or stopword-only query", () => {
    expect(parseSearchQuery("show me")).toEqual({ maxPrice: undefined, minPrice: undefined, keywords: [] });
  });

  it("is case-insensitive", () => {
    expect(parseSearchQuery("RED SHOES UNDER 3000").maxPrice).toBe(3000);
  });
});

describe("fmtMoney", () => {
  it("formats a plain number with thousands grouping", () => {
    expect(fmtMoney(1999, "INR")).toBe("INR 1,999");
  });

  it("formats a large number with Indian digit grouping", () => {
    expect(fmtMoney(123456, "INR")).toBe("INR 1,23,456");
  });

  it("formats a numeric string", () => {
    expect(fmtMoney("799", "INR")).toBe("INR 799");
  });

  it("formats a Decimal-like object (has toString)", () => {
    const decimalLike = { toString: () => "2299.00" };
    expect(fmtMoney(decimalLike, "INR")).toBe("INR 2,299");
  });
});

describe("formatVariantLabel", () => {
  it("returns null for null/non-object attributes", () => {
    expect(formatVariantLabel(null)).toBeNull();
    expect(formatVariantLabel("not an object")).toBeNull();
  });

  it("joins attribute values with a comma", () => {
    expect(formatVariantLabel({ size: "M", color: "Red" })).toBe("M, Red");
  });

  it("filters out empty/falsy attribute values", () => {
    expect(formatVariantLabel({ size: "M", color: "" })).toBe("M");
  });

  it("returns null when there are no truthy values", () => {
    expect(formatVariantLabel({})).toBeNull();
  });
});
