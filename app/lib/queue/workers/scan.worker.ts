import { Worker } from "bullmq";
import redis from "../connection";
import type { ScanJobData } from "../queues";
import { runScan } from "../../services/scan.service";

export function createScanWorker(): Worker<ScanJobData> {
  return new Worker<ScanJobData>(
    "duplify-scan",
    async (job) => {
      await runScan(job.data.migrationJobId);
    },
    { connection: redis, concurrency: 3 },
  );
}
