import type { Job } from "bullmq";
import OpenAI from "openai";
import { MessageDirection, ActivityEventType } from "@prisma/client";
import { prisma } from "../prisma";
import type { FollowUpJobData } from "../queues";

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export async function processFollowUp(job: Job<FollowUpJobData>) {
  const { conversationId, businessId, customerId } = job.data;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId },
    include: {
      customer: true,
      business: { include: { products: { where: { active: true }, take: 20, orderBy: { updatedAt: "desc" }, include: { variants: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } } } } },
      messages: { orderBy: { sentAt: "asc" }, take: 20 },
    },
  });

  if (!conversation) return { skipped: "conversation not found" };
  if (conversation.status === "CLOSED") return { skipped: "conversation closed" };

  // skip if a real (non-draft) outbound reply already exists
  const replied = conversation.messages.some(m => {
    const meta = m.metadata as { state?: string } | null;
    return m.direction === MessageDirection.OUTBOUND && meta?.state !== "draft";
  });
  if (replied) return { skipped: "agent already replied" };

  if (!openai) return { skipped: "OPENAI_API_KEY not configured" };

  const customerName = [conversation.customer.firstName, conversation.customer.lastName].filter(Boolean).join(" ") || "the customer";
  const lastInbound = [...conversation.messages].reverse().find(m => m.direction === MessageDirection.INBOUND);
  const catalog = conversation.business.products.length
    ? conversation.business.products.filter(p => p.variants[0]).map(p => `${p.name} — ${p.variants[0].currency} ${p.variants[0].price}`).join("\n")
    : "No product catalogue connected.";

  const instructions = `You are the AI sales copilot for ${conversation.business.name}. The customer has not received a reply yet. Write one short, warm follow-up message. Acknowledge their enquiry, reference what they asked if known, and offer to help. Do not mention you are an AI. Keep it under 2 sentences.`;
  const input = `Customer: ${customerName}\nChannel: ${conversation.channel}\nProduct catalogue:\n${catalog}\nOriginal message: "${lastInbound?.content ?? "none"}"`;

  let draftContent: string;
  try {
    const response = await openai.responses.create({ model: process.env.OPENAI_MODEL ?? "gpt-4o", instructions, input, store: false });
    draftContent = response.output_text?.trim() ?? "";
    if (!draftContent) return { skipped: "empty AI response" };
  } catch (err) {
    console.error("[follow-up] OpenAI error", err);
    throw err; // rethrow so BullMQ retries the job
  }

  await prisma.$transaction(async (tx) => {
    const draft = await tx.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        content: draftContent,
        metadata: { state: "draft", source: "follow-up" },
      },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: draft.sentAt } });
    await tx.activityEvent.create({
      data: {
        businessId,
        customerId,
        type: ActivityEventType.MESSAGE_SENT,
        summary: `Follow-up draft created for ${customerName}`,
      },
    });
  });

  return { drafted: true, customer: customerName };
}
