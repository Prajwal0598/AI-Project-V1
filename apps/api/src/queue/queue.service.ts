import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";

interface FollowUpJobData { conversationId: string; businessId: string; customerId: string }

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: IORedis;
  private followUpQueue: Queue<FollowUpJobData>;

  constructor() {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.followUpQueue = new Queue("follow-up", { connection: this.connection });
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

  async onModuleDestroy() {
    await this.followUpQueue.close();
    await this.connection.quit();
  }
}
