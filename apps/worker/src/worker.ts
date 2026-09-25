import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
for (const path of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(path)) config({ path, override: false });
}
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { createServer } from "node:http";
import { QUEUES, OrderProgressQueueJob } from "./queues";
import { processFollowUp } from "./jobs/follow-up";
import { makeOrderProgressProcessor } from "./jobs/order-progress";
import { processOrderExpiry } from "./jobs/order-expiry";
import { processAbandonedCart } from "./jobs/abandoned-cart";
import { processRepeatPurchaseScan } from "./jobs/repeat-purchase-scan";
import { processUnansweredConversationScan } from "./jobs/unanswered-conversation-scan";
import { processCustomerHealthScan } from "./jobs/customer-health-scan";
import { processDatabaseBackup } from "./jobs/database-backup";
import { initErrorReporting, captureException } from "./error-reporting";

initErrorReporting();

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
  captureException(err, { queue: QUEUES.FOLLOW_UP, jobId: job?.id });
});

const orderProgressQueue = new Queue<OrderProgressQueueJob>(QUEUES.ORDER_PROGRESS, { connection });
const orderProgressWorker = new Worker(QUEUES.ORDER_PROGRESS, makeOrderProgressProcessor(orderProgressQueue), {
  connection,
  concurrency: 3,
});

orderProgressWorker.on("completed", (job, result) => {
  console.log(`[order-progress] job ${job.id} completed`, result);
});

orderProgressWorker.on("failed", (job, err) => {
  console.error(`[order-progress] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.ORDER_PROGRESS, jobId: job?.id });
});

const orderExpiryWorker = new Worker(QUEUES.ORDER_EXPIRY, processOrderExpiry, {
  connection,
  concurrency: 3,
});

orderExpiryWorker.on("completed", (job, result) => {
  console.log(`[order-expiry] job ${job.id} completed`, result);
});

orderExpiryWorker.on("failed", (job, err) => {
  console.error(`[order-expiry] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.ORDER_EXPIRY, jobId: job?.id });
});

const abandonedCartWorker = new Worker(QUEUES.ABANDONED_CART, processAbandonedCart, {
  connection,
  concurrency: 3,
});

abandonedCartWorker.on("completed", (job, result) => {
  console.log(`[abandoned-cart] job ${job.id} completed`, result);
});

abandonedCartWorker.on("failed", (job, err) => {
  console.error(`[abandoned-cart] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.ABANDONED_CART, jobId: job?.id });
});

const repeatPurchaseScanQueue = new Queue(QUEUES.REPEAT_PURCHASE_SCAN, { connection });
const repeatPurchaseScanWorker = new Worker(QUEUES.REPEAT_PURCHASE_SCAN, processRepeatPurchaseScan, {
  connection,
  concurrency: 1,
});

repeatPurchaseScanWorker.on("completed", (job, result) => {
  console.log(`[repeat-purchase-scan] job ${job.id} completed`, result);
});

repeatPurchaseScanWorker.on("failed", (job, err) => {
  console.error(`[repeat-purchase-scan] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.REPEAT_PURCHASE_SCAN, jobId: job?.id });
});

// runs once daily at 09:00 server time — scans every opted-in business for customers statistically due to reorder
repeatPurchaseScanQueue.add("scan", {}, { repeat: { pattern: process.env.REPEAT_PURCHASE_SCAN_CRON ?? "0 9 * * *" }, jobId: "repeat-purchase-scan-daily" }).catch((err) => {
  console.error("[repeat-purchase-scan] failed to schedule recurring job", err);
});

const unansweredConversationScanQueue = new Queue(QUEUES.UNANSWERED_CONVERSATION_SCAN, { connection });
const unansweredConversationScanWorker = new Worker(QUEUES.UNANSWERED_CONVERSATION_SCAN, processUnansweredConversationScan, {
  connection,
  concurrency: 1,
});

unansweredConversationScanWorker.on("completed", (job, result) => {
  console.log(`[unanswered-conversation-scan] job ${job.id} completed`, result);
});

unansweredConversationScanWorker.on("failed", (job, err) => {
  console.error(`[unanswered-conversation-scan] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.UNANSWERED_CONVERSATION_SCAN, jobId: job?.id });
});

// runs every 30 minutes — escalated conversations shouldn't sit unanswered for long
unansweredConversationScanQueue.add("scan", {}, { repeat: { pattern: process.env.UNANSWERED_CONVERSATION_SCAN_CRON ?? "*/30 * * * *" }, jobId: "unanswered-conversation-scan-recurring" }).catch((err) => {
  console.error("[unanswered-conversation-scan] failed to schedule recurring job", err);
});

const customerHealthScanQueue = new Queue(QUEUES.CUSTOMER_HEALTH_SCAN, { connection });
const customerHealthScanWorker = new Worker(QUEUES.CUSTOMER_HEALTH_SCAN, processCustomerHealthScan, {
  connection,
  concurrency: 1,
});

customerHealthScanWorker.on("completed", (job, result) => {
  console.log(`[customer-health-scan] job ${job.id} completed`, result);
});

customerHealthScanWorker.on("failed", (job, err) => {
  console.error(`[customer-health-scan] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.CUSTOMER_HEALTH_SCAN, jobId: job?.id });
});

// runs once daily at 10:00 server time — win-back and high-value check-in nudges
customerHealthScanQueue.add("scan", {}, { repeat: { pattern: process.env.CUSTOMER_HEALTH_SCAN_CRON ?? "0 10 * * *" }, jobId: "customer-health-scan-daily" }).catch((err) => {
  console.error("[customer-health-scan] failed to schedule recurring job", err);
});

const databaseBackupQueue = new Queue(QUEUES.DATABASE_BACKUP, { connection });
const databaseBackupWorker = new Worker(QUEUES.DATABASE_BACKUP, processDatabaseBackup, {
  connection,
  concurrency: 1,
});

databaseBackupWorker.on("completed", (job, result) => {
  console.log(`[database-backup] job ${job.id} completed`, result);
});

databaseBackupWorker.on("failed", (job, err) => {
  console.error(`[database-backup] job ${job?.id} failed`, err.message);
  captureException(err, { queue: QUEUES.DATABASE_BACKUP, jobId: job?.id });
});

// stopgap until Railway Pro's automatic backups/PITR are enabled (see jobs/database-backup.ts) — runs once
// daily at 03:00 server time (low-traffic window), plus once immediately on startup so a fresh deploy isn't
// left with zero backups for up to 24h waiting for the first scheduled run
databaseBackupQueue.add("backup", {}, { repeat: { pattern: process.env.DATABASE_BACKUP_CRON ?? "0 3 * * *" }, jobId: "database-backup-daily" }).catch((err) => {
  console.error("[database-backup] failed to schedule recurring job", err);
});
databaseBackupQueue.add("backup-initial", {}).catch((err) => {
  console.error("[database-backup] failed to schedule initial job", err);
});

console.log(`[worker] started — connected to Redis at ${redisUrl}`);
console.log(`[worker] processing queues: ${QUEUES.FOLLOW_UP}, ${QUEUES.ORDER_PROGRESS}, ${QUEUES.ORDER_EXPIRY}, ${QUEUES.ABANDONED_CART}, ${QUEUES.REPEAT_PURCHASE_SCAN}, ${QUEUES.UNANSWERED_CONVERSATION_SCAN}, ${QUEUES.CUSTOMER_HEALTH_SCAN}, ${QUEUES.DATABASE_BACKUP}`);

// lightweight health endpoint so Railway/an external uptime monitor can confirm the worker process is actually
// alive and every BullMQ worker is running, not just that the container hasn't crashed
const allWorkers: Record<string, Worker> = {
  [QUEUES.FOLLOW_UP]: followUpWorker, [QUEUES.ORDER_PROGRESS]: orderProgressWorker, [QUEUES.ORDER_EXPIRY]: orderExpiryWorker,
  [QUEUES.ABANDONED_CART]: abandonedCartWorker, [QUEUES.REPEAT_PURCHASE_SCAN]: repeatPurchaseScanWorker,
  [QUEUES.UNANSWERED_CONVERSATION_SCAN]: unansweredConversationScanWorker, [QUEUES.CUSTOMER_HEALTH_SCAN]: customerHealthScanWorker,
  [QUEUES.DATABASE_BACKUP]: databaseBackupWorker,
};
const healthServer = createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
  const workers = Object.fromEntries(Object.entries(allWorkers).map(([name, w]) => [name, w.isRunning()]));
  const healthy = Object.values(workers).every(Boolean);
  res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: healthy ? "ok" : "degraded", service: "ai-customer-agent-worker", workers }));
});
const healthPort = Number(process.env.PORT || process.env.WORKER_PORT) || 4001;
healthServer.listen(healthPort, () => console.log(`[worker] health endpoint listening on :${healthPort}/health`));

process.on("SIGTERM", async () => {
  healthServer.close();
  await followUpWorker.close();
  await orderProgressWorker.close();
  await orderProgressQueue.close();
  await orderExpiryWorker.close();
  await abandonedCartWorker.close();
  await repeatPurchaseScanWorker.close();
  await repeatPurchaseScanQueue.close();
  await unansweredConversationScanWorker.close();
  await unansweredConversationScanQueue.close();
  await customerHealthScanWorker.close();
  await customerHealthScanQueue.close();
  await databaseBackupWorker.close();
  await databaseBackupQueue.close();
  await connection.quit();
  process.exit(0);
});
