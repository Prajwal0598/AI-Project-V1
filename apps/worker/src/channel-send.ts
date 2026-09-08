// mirrors the send logic in apps/api's ConversationService — duplicated here because the worker is a
// separate process with its own Prisma client and no access to the API's NestJS DI container.

type Channel = "WHATSAPP" | "INSTAGRAM" | "EMAIL" | "FACEBOOK" | "WEB" | "MANUAL";

async function sendWhatsApp(phoneNumberId: string, to: string, content: string): Promise<string | null> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN is not configured.");
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: content.trim() } }),
  });
  if (!res.ok) throw new Error(`WhatsApp API error: ${JSON.stringify(await res.json().catch(() => ({})))}`);
  const data = (await res.json()) as { messages?: { id: string }[] };
  return data.messages?.[0]?.id ?? null;
}

async function sendInstagram(pageId: string, to: string, content: string): Promise<string | null> {
  const accessToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!accessToken) throw new Error("INSTAGRAM_PAGE_ACCESS_TOKEN is not configured.");
  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/messages?access_token=${accessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: to }, message: { text: content.trim() } }),
  });
  if (!res.ok) throw new Error(`Instagram API error: ${JSON.stringify(await res.json().catch(() => ({})))}`);
  const data = (await res.json()) as { message_id?: string };
  return data.message_id ?? null;
}

async function sendEmail(supportEmail: string, to: string, subject: string | null, content: string): Promise<string | null> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.EMAIL_FROM;
  if (!token || !from) throw new Error("POSTMARK_SERVER_TOKEN or EMAIL_FROM is not configured.");
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({ From: from, To: to, Subject: subject ? `Re: ${subject}` : "Re: your order", TextBody: content.trim(), MessageStream: "outbound" }),
  });
  if (!res.ok) throw new Error(`Postmark API error: ${JSON.stringify(await res.json().catch(() => ({})))}`);
  const data = (await res.json()) as { MessageID?: string };
  return data.MessageID ?? null;
}

export async function sendChannelMessage(
  channel: Channel,
  business: { whatsappPhoneNumberId: string | null; instagramPageId: string | null; supportEmail: string | null },
  to: string,
  content: string,
  subject: string | null
): Promise<string | null> {
  if (channel === "WHATSAPP") {
    if (!business.whatsappPhoneNumberId) throw new Error("WhatsApp phone number ID not configured for this business.");
    return sendWhatsApp(business.whatsappPhoneNumberId, to, content);
  }
  if (channel === "INSTAGRAM") {
    if (!business.instagramPageId) throw new Error("Instagram Page ID not configured for this business.");
    return sendInstagram(business.instagramPageId, to, content);
  }
  if (channel === "EMAIL") {
    if (!business.supportEmail) throw new Error("Support email not configured for this business.");
    return sendEmail(business.supportEmail, to, subject, content);
  }
  throw new Error(`Send is only supported for WhatsApp, Instagram, and Email — got ${channel}.`);
}
