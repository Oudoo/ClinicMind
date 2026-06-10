import * as Sentry from "@sentry/node";
import { env, recordHeartbeat } from "@growengine/core";
import { createIntegrationWorker } from "./workers/integration.js";
import { createAiWorker } from "./workers/ai/index.js";
import { createResearchWorker } from "./workers/research.js";
import { createNotificationWorker } from "./workers/notification.js";
import { createEventsWorker } from "./workers/events.js";
import { startScheduler } from "./scheduler.js";

/**
 * The Grow Engine — Background Worker Service.
 * All heavy processing (AI, syncs, crawling, notifications, events) runs
 * here, never inside the Next.js request cycle.
 */

if (env.glitchtipDsn) {
  Sentry.init({ dsn: env.glitchtipDsn, environment: env.nodeEnv });
}

const workers = [
  { name: "integration", worker: createIntegrationWorker() },
  { name: "ai", worker: createAiWorker() },
  { name: "research", worker: createResearchWorker() },
  { name: "notification", worker: createNotificationWorker() },
  { name: "events", worker: createEventsWorker() },
];

for (const { name, worker } of workers) {
  worker.on("error", (err) => {
    console.error(`[worker:${name}] error`, err);
    if (env.glitchtipDsn) Sentry.captureException(err);
  });
  console.log(`[worker:${name}] started`);
}

// Heartbeats for the System Health Dashboard
const heartbeat = setInterval(() => {
  for (const { name } of workers) {
    recordHeartbeat(name).catch(() => {});
  }
}, 30_000);
for (const { name } of workers) recordHeartbeat(name).catch(() => {});

const stopScheduler = startScheduler();
console.log("[scheduler] started");

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  clearInterval(heartbeat);
  stopScheduler();
  await Promise.allSettled(workers.map(({ worker }) => worker.close()));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log("The Grow Engine worker service is running.");
