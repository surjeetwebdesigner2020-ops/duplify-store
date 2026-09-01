import db from "../../db.server";
import {
  getMigrationJob,
  isMigrationCancelled,
  logEvent,
  recalculateJobCounters,
  setJobStatus,
} from "./migrationJob.service";
import {
  backfillProductReferenceMetafields,
  runProductsStage,
} from "./processors/products.processor";
import { runImagesStage } from "./processors/images.processor";
import { runCollectionsStage } from "./processors/collections.processor";
import { runCustomersStage } from "./processors/customers.processor";
import { runPagesStage } from "./processors/pages.processor";
import { runBlogsStage } from "./processors/blogs.processor";
import { runFilesStage } from "./processors/files.processor";
import { runMetafieldDefinitionsStage } from "./processors/metafieldDefinitions.processor";
import { runMetaobjectDefinitionsStage, runMetaobjectsStage } from "./processors/metaobjects.processor";
import { runMenusStage } from "./processors/menus.processor";
import { runInventoryStage } from "./processors/inventory.processor";
import { runDiscountsStage } from "./processors/discounts.processor";
import { runOrdersStage } from "./processors/orders.processor";
import { runThemeStage } from "./processors/theme.processor";
import { MAX_ATTEMPTS } from "./processors/products.processor";

export type MigrationJobWithConnection = NonNullable<
  Awaited<ReturnType<typeof getMigrationJob>>
>;

// Full spec migration order (Files, Metafield/Metaobject definitions,
// Products, Variants, Images, Inventory, Collections, Customers, Pages,
// Blogs, Menus, Discounts, Orders, Theme). Two deliberate deviations from the
// spec's literal ordering:
//  - Metaobject *entries* run after Customers/Pages/Blogs (not right after
//    their definitions) because entry fields can reference those resources,
//    and reference remapping only works once the referenced record has
//    already been migrated and mapped.
//  - Images runs right after Products (not after Variants) since images
//    attach to the product record itself, matching how productSet already
//    creates products+variants together in one stage (see products.processor.ts).
const STAGE_RUNNERS: Record<
  string,
  (job: MigrationJobWithConnection) => Promise<void>
> = {
  files: runFilesStage,
  metafield_definitions: runMetafieldDefinitionsStage,
  metaobject_definitions: runMetaobjectDefinitionsStage,
  products: runProductsStage,
  images: runImagesStage,
  inventory: runInventoryStage,
  collections: runCollectionsStage,
  customers: runCustomersStage,
  pages: runPagesStage,
  blogs: runBlogsStage,
  menus: runMenusStage,
  metaobjects: runMetaobjectsStage,
  discounts: runDiscountsStage,
  orders: runOrdersStage,
  theme: runThemeStage,
};

const STAGE_ORDER = [
  "files",
  "metafield_definitions",
  "metaobject_definitions",
  "products",
  "images",
  "inventory",
  "collections",
  "customers",
  "pages",
  "blogs",
  "menus",
  "metaobjects",
  "discounts",
  "orders",
  "theme",
];

function resourceTypesForStage(stage: string): string[] {
  if (stage === "images") return ["images"];
  if (stage === "inventory") return ["inventory"]; // opt-in separately from products (needs its own scopes)
  return [stage];
}

export function stagesForJob(selectedResources: string[]): string[] {
  return STAGE_ORDER.filter((stage) =>
    resourceTypesForStage(stage).some((r) => selectedResources.includes(r)),
  );
}

export async function startMigration(migrationJobId: string): Promise<void> {
  await setJobStatus(migrationJobId, "QUEUED", { startedAt: new Date() });
  await logEvent(migrationJobId, "INFO", "Migration started");
  await runStages(migrationJobId);
}

// Used both to resume after a retry and (defensively) if a worker crashed
// mid-migration and the job needs to be re-driven — each stage runner only
// touches its own PENDING/RETRYING MigrationItem rows, so stages that already
// finished complete instantly here instead of redoing any work.
export async function resumeMigration(migrationJobId: string): Promise<void> {
  await logEvent(migrationJobId, "INFO", "Resuming migration");
  await runStages(migrationJobId);
}

async function runStages(migrationJobId: string): Promise<void> {
  const initialJob = await getMigrationJob(migrationJobId);
  if (!initialJob) throw new Error(`MigrationJob ${migrationJobId} not found`);

  const stages = stagesForJob(initialJob.selectedResources as string[]);
  await setJobStatus(migrationJobId, "RUNNING");

  let stageFailures = 0;

  for (const stage of stages) {
    const job = await getMigrationJob(migrationJobId);
    if (!job || job.status === "CANCELLED") return;

    await setJobStatus(migrationJobId, "RUNNING", { currentStage: stage });
    await logEvent(migrationJobId, "INFO", `Running stage: ${stage}`);

    try {
      await STAGE_RUNNERS[stage](job);
    } catch (error) {
      if (await isMigrationCancelled(migrationJobId)) {
        await recalculateJobCounters(migrationJobId);
        return;
      }
      const message =
        error instanceof Error ? error.message : String(error);
      const isThemePermissionIssue =
        stage === "theme" &&
        /themeCreate|write_themes|Access denied.*theme|requires.*write_themes/i.test(
          message,
        );
      if (isThemePermissionIssue) {
        await logEvent(
          migrationJobId,
          "WARN",
          "Theme migration skipped because the destination store lacks write_themes permission. Other migration work was still completed successfully.",
        );
        await recalculateJobCounters(migrationJobId);
        continue;
      }
      stageFailures += 1;
      await logEvent(migrationJobId, "ERROR", `Stage ${stage} failed`, {
        error: message,
      });
      await logEvent(
        migrationJobId,
        "ERROR",
        message || `Stage ${stage} failed with an unknown error`,
      );
      await logEvent(
        migrationJobId,
        "WARN",
        `Continuing migration after ${stage} failure so later stages (e.g. theme) can still run`,
      );
      await recalculateJobCounters(migrationJobId);
      continue;
    }

    await recalculateJobCounters(migrationJobId);
    if (await isMigrationCancelled(migrationJobId)) return;
  }

  // Reference metafields must be written only after every selected resource
  // has had a chance to create/update its source -> destination ID mapping.
  // Running this on every product migration also repairs metadata after a
  // merchant deletes a destination product and imports it again.
  if (stages.includes("products")) {
    const job = await getMigrationJob(migrationJobId);
    if (job && job.status !== "CANCELLED") {
      await logEvent(migrationJobId, "INFO", "Backfilling product reference metafields");
      try {
        await backfillProductReferenceMetafields(job);
      } catch (error) {
        stageFailures += 1;
        await logEvent(migrationJobId, "ERROR", "Product reference metafield backfill failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const finalCounters = await recalculateJobCounters(migrationJobId);
  if (await isMigrationCancelled(migrationJobId)) return;
  if (stageFailures > 0 || finalCounters.failed > 0) {
    await setJobStatus(migrationJobId, "FAILED", {
      completedAt: new Date(),
      currentStage: null,
    });
    await logEvent(
      migrationJobId,
      "WARN",
      `Migration finished with errors (${stageFailures} stage failure(s), ${finalCounters.failed} failed record(s))`,
    );
    return;
  }

  await setJobStatus(migrationJobId, "COMPLETED", {
    completedAt: new Date(),
    currentStage: null,
  });
  await logEvent(migrationJobId, "INFO", "Migration completed");
}

export async function cancelMigration(migrationJobId: string): Promise<void> {
  await setJobStatus(migrationJobId, "CANCELLED");
  await logEvent(migrationJobId, "WARN", "Migration cancelled by merchant");
}

// Marks eligible FAILED items as RETRYING. The caller is responsible for
// enqueuing a "resume" migration-queue job when this returns a count > 0 —
// kept separate from resumeMigration (rather than calling it here) so this
// stays a fast, synchronous web-request-safe DB write.
export async function markItemsForRetry(migrationJobId: string): Promise<number> {
  const failed = await db.migrationItem.updateMany({
    where: {
      migrationJobId,
      status: "FAILED",
      attempt: { lt: MAX_ATTEMPTS },
    },
    data: { status: "RETRYING" },
  });

  // Remap skipped metafield/metaobject definitions that already exist on dest.
  const skippedDefs = await db.migrationItem.updateMany({
    where: {
      migrationJobId,
      status: "SKIPPED",
      resourceType: { in: ["metafield_definition", "metaobject_definition"] },
    },
    data: { status: "RETRYING" },
  });

  const count = failed.count + skippedDefs.count;
  if (count > 0) {
    await logEvent(
      migrationJobId,
      "INFO",
      `Marked ${count} item(s) for retry (${failed.count} failed, ${skippedDefs.count} skipped definitions)`,
    );
  }

  return count;
}
