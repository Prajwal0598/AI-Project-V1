import { parseWhatsAppWebhook } from "./whatsapp-parser";

function textPayload(overrides: Partial<{ type: string; text: string; interactive: unknown; contacts: unknown[] }> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "PHONE123" },
          contacts: overrides.contacts ?? [{ wa_id: "911234567890", profile: { name: "Test Customer" } }],
          messages: [{
            from: "911234567890",
            id: "wamid.ABC123",
            timestamp: "1700000000",
            type: overrides.type ?? "text",
            ...(overrides.type === "interactive" ? { interactive: overrides.interactive } : { text: { body: overrides.text ?? "Hi" } }),
          }],
        },
      }],
    }],
  };
}

describe("parseWhatsAppWebhook", () => {
  it("returns an empty array for a payload that isn't a WhatsApp business account event", () => {
    expect(parseWhatsAppWebhook({ object: "page" })).toEqual([]);
    expect(parseWhatsAppWebhook(null)).toEqual([]);
    expect(parseWhatsAppWebhook(undefined)).toEqual([]);
  });

  it("parses a plain text message", () => {
    const result = parseWhatsAppWebhook(textPayload({ text: "Hello there" }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      phoneNumberId: "PHONE123",
      from: "911234567890",
      waMessageId: "wamid.ABC123",
      text: "Hello there",
      interactiveId: null,
      displayName: "Test Customer",
    });
    expect(result[0].timestamp).toEqual(new Date(1700000000 * 1000));
  });

  it("defaults to an empty string body when the text object is missing", () => {
    const payload = textPayload();
    (payload.entry[0].changes[0].value.messages[0] as any).text = undefined;
    const result = parseWhatsAppWebhook(payload);
    expect(result[0].text).toBe("");
  });

  it("parses an interactive button reply", () => {
    const result = parseWhatsAppWebhook(textPayload({
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "menu_shop", title: "🛍️ Shop" } },
    }));
    expect(result[0]).toMatchObject({ text: "🛍️ Shop", interactiveId: "menu_shop" });
  });

  it("parses an interactive list reply", () => {
    const result = parseWhatsAppWebhook(textPayload({
      type: "interactive",
      interactive: { type: "list_reply", list_reply: { id: "cat_123", title: "Jeans" } },
    }));
    expect(result[0]).toMatchObject({ text: "Jeans", interactiveId: "cat_123" });
  });

  it("skips an interactive message with neither a button nor list reply", () => {
    const result = parseWhatsAppWebhook(textPayload({ type: "interactive", interactive: {} }));
    expect(result).toEqual([]);
  });

  it("ignores changes whose field isn't 'messages' (e.g. status updates)", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "message_template_status_update", value: {} }] }],
    };
    expect(parseWhatsAppWebhook(payload)).toEqual([]);
  });

  it("resolves the display name from contacts by wa_id, falling back to null", () => {
    const noContact = parseWhatsAppWebhook(textPayload({ contacts: [] }));
    expect(noContact[0].displayName).toBeNull();
  });

  it("parses multiple messages across multiple entries/changes", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        { changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "P1" }, contacts: [],
          messages: [{ from: "111", id: "m1", timestamp: "1700000000", type: "text", text: { body: "one" } }],
        } }] },
        { changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "P1" }, contacts: [],
          messages: [{ from: "222", id: "m2", timestamp: "1700000001", type: "text", text: { body: "two" } }],
        } }] },
      ],
    };
    const result = parseWhatsAppWebhook(payload);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.text)).toEqual(["one", "two"]);
  });
});
