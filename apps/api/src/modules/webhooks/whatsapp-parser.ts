export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  from: string;
  waMessageId: string;
  text: string;
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
        if ((message.type as string) !== "text") continue;
        const textObj = message.text as Record<string, string>;
        results.push({
          phoneNumberId,
          from: message.from as string,
          waMessageId: message.id as string,
          text: textObj?.body ?? "",
          displayName: contactMap[message.from as string] ?? null,
          timestamp: new Date(Number(message.timestamp) * 1000),
        });
      }
    }
  }

  return results;
}
