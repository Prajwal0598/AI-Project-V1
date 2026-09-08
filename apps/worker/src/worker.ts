import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(path)) config({ path, override: false });
}
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { QUEUES, OrderProgressJobData } from "./queues";
import { processFollowUp } from "./jobs/follow-up";
import { makeOrderProgressProcessor } from "./jobs/order-progress";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const followUpWorker = new Worker(QUEUES.FOLLOW_UP, processFollowUp, {
  connection,
  concurrency: 3,
});

followUpWorker.on("completed", (job, result) => {
  console.log(`[follow-up] job ${job.id} completed`, result);
});

followUpWorker.on("failed", (job, err) => {
  console.error(`[follow-up] job ${job?.id} failed`, err.message);
});

const orderProgressQueue = new Queue<OrderProgressJobData>(QUEUES.ORDER_PROGRESS, { connection });
const orderProgressWorker = new Worker(QUEUES.ORDER_PROGRESS, makeOrderProgressProcessor(orderProgressQueue), {
  connection,
  concurrency: 3,
});

orderProgressWorker.on("completed", (job, result) => {
  console.log(`[order-progress] job ${job.id} completed`, result);
});

orderProgressWorker.on("failed", (job, err) => {
  console.error(`[order-progress] job ${job?.id} failed`, err.message);
});

console.log(`[worker] started — connected to Redis at ${redisUrl}`);
console.log(`[worker] processing queues: ${QUEUES.FOLLOW_UP}, ${QUEUES.ORDER_PROGRESS}`);

process.on("SIGTERM", async () => {
  await followUpWorker.close();
  await orderProgressWorker.close();
  await orderProgressQueue.close();
  await connection.quit();
  process.exit(0);
});
