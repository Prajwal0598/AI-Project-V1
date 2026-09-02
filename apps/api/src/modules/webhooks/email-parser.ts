export interface ParsedEmailMessage {
  toAddress: string;
  from: string;
  fromName: string | null;
  subject: string;
  text: string;
  messageId: string;
}

// Postmark inbound webhook payload — https://postmarkapp.com/developer/webhooks/inbound-webhook
export function parseEmailWebhook(body: unknown): ParsedEmailMessage | null {
  const payload = body as Record<string, unknown>;
  const from = payload.From as string | undefined;
  const to = payload.To as string | undefined;
  const messageId = payload.MessageID as string | undefined;
  if (!from || !to || !messageId) return null;

  return {
    toAddress: extractEmail(to),
    from: extractEmail(from),
    fromName: (payload.FromName as string) || null,
    subject: (payload.Subject as string) ?? "",
    text: (payload.TextBody as string) ?? (payload.StrippedTextReply as string) ?? "",
    messageId,
  };
}

// strips display name from "John Doe <john@example.com>" formatted addresses
function extractEmail(raw: string): string {
  const match = raw.match(/<(.+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}
