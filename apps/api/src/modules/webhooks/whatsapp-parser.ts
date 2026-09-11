export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  from: string;
  waMessageId: string;
  text: string;
  // set when this message is a tap on an interactive button/list row rather than typed text — carries the
  // action id we encoded when sending the menu/list (e.g. "cat_<id>", "prod_<id>", "cart_checkout")
  interactiveId: string | null;
  displayName: string | null;
  timestamp: Date;
}

export function parseWhatsAppWebhook(body: unknown): ParsedWhatsAppMessage[] {
  const payload = body as Record<string, unknown>;
  if (payload?.object !== "whatsapp_business_account") return [];

  const results: ParsedWhatsAppMessage[] = [];

  for (const entry of (payload.entry as Record<string, unknown>[]) ?? []) {
    for (const change of (entry.changes as Record<string, unknown>[]) ?? []) {
      if ((change.field as string) !== "messages") continue;

      const value = change.value as Record<string, unknown>;
      const meta = value.metadata as Record<string, string>;
      const phoneNumberId = meta?.phone_number_id;

      const contactMap: Record<string, string | null> = {};
      for (const contact of (value.contacts as Record<string, unknown>[]) ?? []) {
        const profile = contact.profile as Record<string, string>;
        contactMap[contact.wa_id as string] = profile?.name ?? null;
      }

      for (const message of (value.messages as Record<string, unknown>[]) ?? []) {
        const type = message.type as string;
        const base = {
          phoneNumberId,
          from: message.from as string,
          waMessageId: message.id as string,
          displayName: contactMap[message.from as string] ?? null,
          timestamp: new Date(Number(message.timestamp) * 1000),
        };

        if (type === "text") {
          const textObj = message.text as Record<string, string>;
          results.push({ ...base, text: textObj?.body ?? "", interactiveId: null });
        } else if (type === "interactive") {
          const interactive = message.interactive as Record<string, unknown>;
          const buttonReply = interactive?.button_reply as Record<string, string> | undefined;
          const listReply = interactive?.list_reply as Record<string, string> | undefined;
          const reply = buttonReply ?? listReply;
          if (!reply) continue;
          results.push({ ...base, text: reply.title ?? reply.id, interactiveId: reply.id });
        }
      }
    }
  }

  return results;
}

