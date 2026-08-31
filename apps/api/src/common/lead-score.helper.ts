import { PrismaService } from "../database/prisma.service";

export async function recalculateLeadScore(prisma: PrismaService, customerId: string, businessId: string): Promise<void> {
  const [convCount, paidOrderCount, lastMsg] = await Promise.all([
    prisma.conversation.count({ where: { customerId, businessId } }),
    prisma.order.count({ where: { customerId, businessId, status: { in: ["PAID", "FULFILLED"] } } }),
    prisma.message.findFirst({
      where: { conversation: { customerId, businessId } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
  ]);

  const daysSinceLast = lastMsg
    ? (Date.now() - new Date(lastMsg.sentAt).getTime()) / 86_400_000
    : 999;

  const score = Math.min(
    100,
    convCount * 10 +
    (paidOrderCount > 0 ? 30 : 0) +
    (daysSinceLast < 1 ? 20 : daysSinceLast < 7 ? 10 : 0),
  );

  await prisma.leadScore.upsert({
    where: { customerId },
    create: { customerId, score, reason: `${convCount} conv · ${paidOrderCount} paid orders` },
    update: { score, reason: `${convCount} conv · ${paidOrderCount} paid orders`, calculatedAt: new Date() },
  });
}
