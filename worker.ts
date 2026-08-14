// Standalone entrypoint for the BullMQ worker process. Deployed and run
// separately from the web process (see docker/Dockerfile.worker) since
// migrations are long-running and must survive independently of web request
// lifecycles.
import "dotenv/config";
import { env } from "./app/env.server";
import { createScanWorker } from "./app/lib/queue/workers/scan.worker";
import { createMigrationWorker } from "./app/lib/queue/workers/migration.worker";

env(); // fail fast on missing/invalid configuration

const scanWorker = createScanWorker();
const migrationWorker = createMigrationWorker();

for (const worker of [scanWorker, migrationWorker]) {
  worker.on("failed", (job, error) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, error);
  });
  worker.on("error", (error) => {
    console.error(`[${worker.name}] worker error:`, error);
  });
}

console.log("Duplify Store worker started (scan + migration queues)");

async function shutdown() {
  console.log("Shutting down worker...");
  await Promise.all([scanWorker.close(), migrationWorker.close()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
