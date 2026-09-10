import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";

interface FollowUpJobData { conversationId: string; businessId: string; customerId: string }
interface OrderProgressJobData { orderId: string; businessId: string; nextStatus: "PAID" | "FULFILLED" }
interface OrderExpiryJobData { orderId: string; businessId: string; expectedStatus: "AWAITING_APPROVAL" | "PENDING_PAYMENT" }

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: IORedis;
  private followUpQueue: Queue<FollowUpJobData>;
  private orderProgressQueue: Queue<OrderProgressJobData>;
  private orderExpiryQueue: Queue<OrderExpiryJobData>;

  constructor() {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.followUpQueue = new Queue("follow-up", { connection: this.connection });
    this.orderProgressQueue = new Queue("order-progress", { connection: this.connection });
    this.orderExpiryQueue = new Queue("order-expiry", { connection: this.connection });
    this.logger.log(`Queue service ready — Redis at ${redisUrl}`);
  }

  async scheduleFollowUp(conversationId: string, businessId: string, customerId: string) {
    const delay = parseInt(process.env.FOLLOW_UP_DELAY_MS ?? "86400000", 10);
    await this.followUpQueue.add("check", { conversationId, businessId, customerId }, {
      delay,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    });
    this.logger.log(`Follow-up scheduled for conversation ${conversationId} in ${Math.round(delay / 3_600_000)}h`);
  }

  // simulated autonomous payment/shipment progression — no real payment gateway or courier is connected yet
  async scheduleOrderProgress(orderId: string, businessId: string) {
    const delay = parseInt(process.env.ORDER_AUTO_PAID_DELAY_MS ?? "300000", 10); // default 5 min
    await this.orderProgressQueue.add("advance", { orderId, businessId, nextStatus: "PAID" }, {
      delay,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    });
    this.logger.log(`Order ${orderId} auto-progress scheduled — PAID (simulated) in ${Math.round(delay / 60_000)}min`);
  }

  /** Schedules an order to auto-cancel (and release reserved stock) if it's still in expectedStatus once the timeout elapses. */
  async scheduleOrderExpiry(orderId: string, businessId: string, expectedStatus: "AWAITING_APPROVAL" | "PENDING_PAYMENT") {
    const delay = expectedStatus === "AWAITING_APPROVAL"
      ? parseInt(process.env.ORDER_APPROVAL_EXPIRY_MS ?? "86400000", 10) // default 24h to approve
      : parseInt(process.env.ORDER_PAYMENT_EXPIRY_MS ?? "1800000", 10); // default 30min to pay
    await this.orderExpiryQueue.add("expire", { orderId, businessId, expectedStatus }, {
      delay,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
    });
    this.logger.log(`Order ${orderId} expiry scheduled — cancels if still ${expectedStatus.toLowerCase()} in ${Math.round(delay / 60_000)}min`);
  }

  async onModuleDestroy() {
    await this.followUpQueue.close();
    await this.orderProgressQueue.close();
    await this.orderExpiryQueue.close();
    await this.connection.quit();
  }
}
