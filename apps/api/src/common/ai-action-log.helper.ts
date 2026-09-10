import { PrismaService } from "../database/prisma.service";

/** Records an autonomous AI decision with real-world consequence — the audit trail for what the AI did, why, and the outcome. */
export async function logAiAction(
  prisma: PrismaService,
  params: { businessId: string; customerId?: string; conversationId?: string; orderId?: string; action: string; reason?: string; result: string }
): Promise<void> {
  await prisma.aiActionLog.create({
    data: {
      businessId: params.businessId,
      customerId: params.customerId ?? null,
      conversationId: params.conversationId ?? null,
      orderId: params.orderId ?? null,
      action: params.action,
      reason: params.reason ?? null,
      result: params.result,
    },
  });
}
