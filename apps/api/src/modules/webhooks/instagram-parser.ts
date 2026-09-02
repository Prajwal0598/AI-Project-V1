export interface ParsedInstagramMessage {
  pageId: string;
  from: string;
  igMessageId: string;
  text: string;
  timestamp: Date;
}

// Instagram Graph API webhook payload: entry[].messaging[] (different shape from WhatsApp's entry[].changes[])
export function parseInstagramWebhook(body: unknown): ParsedInstagramMessage[] {
  const payload = body as Record<string, unknown>;
  if (payload?.object !== "instagram") return [];

  const results: ParsedInstagramMessage[] = [];

  for (const entry of (payload.entry as Record<string, unknown>[]) ?? []) {
    const pageId = entry.id as string;
    for (const event of (entry.messaging as Record<string, unknown>[]) ?? []) {
      const message = event.message as Record<string, unknown> | undefined;
      if (!message || message.is_echo) continue; // skip echoes of our own outbound sends
      const sender = event.sender as Record<string, string>;
      const text = message.text as string | undefined;
      if (!text) continue;

      results.push({
        pageId,
        from: sender?.id,
        igMessageId: message.mid as string,
        text,
        timestamp: new Date(Number(event.timestamp ?? Date.now())),
      });
    }
  }

  return results;
}
