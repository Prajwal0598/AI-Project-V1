import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../database/prisma.service";

// grace window after PAST_DUE before paid functionality is actually restricted — configurable, never hard-coded
// at every call site
function pastDueGraceDays(): number {
  return Number(process.env.RELAY_PAST_DUE_GRACE_DAYS ?? 3);
}

/** The single source of truth for "can this business currently use Relay's paid functionality" — every
 * feature-access decision should call this instead of inspecting Subscription.status directly. */
@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async canUseRelay(businessId: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findUnique({ where: { businessId } });
    if (!subscription) return false; // never started billing at all
    return this.evaluate(subscription, new Date());
  }

  private evaluate(
    subscription: { status: string; trialEnd: Date | null; currentPeriodEnd: Date | null },
    now: Date,
  ): boolean {
    switch (subscription.status) {
      case "TRIAL":
        return !!subscription.trialEnd && subscription.trialEnd > now;
      case "ACTIVE":
        return true;
      case "PAYMENT_FAILED":
        // still retrying — spec: "allowed during configured recovery"
        return true;
      case "PAST_DUE": {
        if (!subscription.currentPeriodEnd) return false;
        const graceEnd = new Date(subscription.currentPeriodEnd.getTime() + pastDueGraceDays() * 24 * 60 * 60 * 1000);
        return now <= graceEnd;
      }
      case "CANCELLED":
        // cancel-at-period-end: still entitled until the paid period they already paid for actually ends
        return !!subscription.currentPeriodEnd && subscription.currentPeriodEnd > now;
      case "EXPIRED":
      case "SUSPENDED":
      default:
        return false;
    }
  }
}
