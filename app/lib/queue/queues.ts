import { Queue } from "bullmq";
import redis from "./connection";

export interface ScanJobData {
  migrationJobId: string;
}

export interface MigrationJobData {
  migrationJobId: string;
  mode: "start" | "resume";
}

export const scanQueue = new Queue<ScanJobData>("duplify-scan", {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

export const migrationQueue = new Queue<MigrationJobData>("duplify-migration", {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});
