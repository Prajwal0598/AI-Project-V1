import "dotenv/config";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "./queues";
import { processFollowUp } from "./jobs/follow-up";

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

console.log(`[worker] started — connected to Redis at ${redisUrl}`);
console.log(`[worker] processing queue: ${QUEUES.FOLLOW_UP}`);

process.on("SIGTERM", async () => {
  await followUpWorker.close();
  await connection.quit();
  process.exit(0);
});
