import type { LogLevel, MigrationJobStatus, MigrationType, Prisma } from "@prisma/client";
import db from "../../db.server";

export interface CreateMigrationJobInput {
  storeConnectionId: string;
  type: MigrationType;
  selectedResources: string[];
  // Per-resource-type conflict strategy, plus the occasional reserved
  // "__"-prefixed key for out-of-band choices that don't have their own
  // MigrationJob column (e.g. __themeSourceId — see theme.processor.ts).
  conflictStrategy: Record<string, "OVERWRITE" | "SKIP" | "MERGE" | "CREATE_NEW" | string>;
}

export async function createMigrationJob(input: CreateMigrationJobInput) {
  return db.migrationJob.create({
    data: {
      storeConnectionId: input.storeConnectionId,
      type: input.type,
      selectedResources: input.selectedResources,
      conflictStrategy: input.conflictStrategy,
      status: "DRAFT",
    },
  });
}

export async function getMigrationJob(id: string) {
  return db.migrationJob.findUnique({
    where: { id },
    include: {
      storeConnection: {
        include: { sourceShop: true, destinationShop: true },
      },
    },
  });
}

export async function setJobStatus(
  id: string,
  status: MigrationJobStatus,
  extra: Partial<{
    startedAt: Date;
    completedAt: Date;
    currentStage: string | null;
  }> = {},
) {
  if (status !== "CANCELLED") {
    return db.migrationJob.updateMany({
      where: { id, status: { not: "CANCELLED" } },
      data: { status, ...extra },
    });
  }
  return db.migrationJob.update({ where: { id }, data: { status, ...extra } });
}

// Processors load pending items in advance, so check the persisted job status
// before beginning each item or batch rather than trusting the initial job.
// A cancelled job leaves unstarted items in their existing PENDING/RETRYING
// state for a later explicit retry.
export async function isMigrationCancelled(migrationJobId: string): Promise<boolean> {
  const job = await db.migrationJob.findUnique({
    where: { id: migrationJobId },
    select: { status: true },
  });
  return job?.status === "CANCELLED";
}

// Every mutating action (create/update/skip/overwrite/retry) writes one of
// these — this table is the audit trail the spec requires, scoped per job.
export async function logEvent(
  migrationJobId: string,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (level === "ERROR" || level === "WARN") {
    const payload = {
      migrationJobId,
      level,
      message,
      ...(meta ? { meta } : {}),
    };
    const logger = level === "ERROR" ? console.error : console.warn;
    logger(`[Duplify migration ${level}]`, JSON.stringify(payload, null, 2));
  }

  await db.migrationLog.create({
    data: {
      migrationJobId,
      level,
      message,
      meta: meta as Prisma.InputJsonValue | undefined,
    },
  });
}

// Recomputes the job's aggregate counters from its MigrationItem rows. Called
// after each batch rather than incrementing counters inline, so a crashed/
// retried worker can never leave the totals out of sync with reality.
export async function recalculateJobCounters(migrationJobId: string) {
  const [completed, failed, skipped, total] = await Promise.all([
    db.migrationItem.count({
      where: { migrationJobId, status: "COMPLETED" },
    }),
    db.migrationItem.count({ where: { migrationJobId, status: "FAILED" } }),
    db.migrationItem.count({ where: { migrationJobId, status: "SKIPPED" } }),
    db.migrationItem.count({ where: { migrationJobId } }),
  ]);

  await db.migrationJob.update({
    where: { id: migrationJobId },
    data: {
      completedRecords: completed,
      failedRecords: failed,
      skippedRecords: skipped,
      totalRecords: total,
    },
  });

  return { completed, failed, skipped, total };
}

export interface MigrationHistoryFilters {
  ownerShopId: string;
  status?: MigrationJobStatus;
  type?: MigrationType;
  search?: string;
}

export async function listMigrationJobs(filters: MigrationHistoryFilters) {
  return db.migrationJob.findMany({
    where: {
      status: filters.status,
      type: filters.type,
      storeConnection: {
        ownerShopId: filters.ownerShopId,
        ...(filters.search
          ? {
              AND: [
                {
                  OR: [
                    {
                      sourceShop: {
                        shopDomain: { contains: filters.search, mode: "insensitive" },
                      },
                    },
                    {
                      destinationShop: {
                        shopDomain: { contains: filters.search, mode: "insensitive" },
                      },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    },
    include: { storeConnection: { include: { sourceShop: true, destinationShop: true } } },
    orderBy: { createdAt: "desc" },
  });
}
