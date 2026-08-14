import { Worker } from "bullmq";
import redis from "../connection";
import type { MigrationJobData } from "../queues";
import { resumeMigration, startMigration } from "../../services/orchestrator.service";

export function createMigrationWorker(): Worker<MigrationJobData> {
  return new Worker<MigrationJobData>(
    "duplify-migration",
    async (job) => {
      if (job.data.mode === "resume") {
        await resumeMigration(job.data.migrationJobId);
      } else {
        await startMigration(job.data.migrationJobId);
      }
    },
    {
      connection: redis,
      // One migration at a time per worker process — stages within a job
      // already parallelize at the HTTP-request level via the rate limiter;
      // running multiple *jobs* concurrently mainly increases the chance of
      // two jobs racing on the same store's Shopify rate-limit bucket.
      concurrency: 1,
      lockDuration: 5 * 60 * 1000,
    },
  );
}
