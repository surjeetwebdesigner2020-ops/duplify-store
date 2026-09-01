import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import { BULK_PAGES_QUERY, PAGE_BY_HANDLE_QUERY } from "../../shopify/queries/content";
import {
  PAGE_CREATE_MUTATION,
  PAGE_UPDATE_MUTATION,
  type PageCreateInput,
  type PageUpdateInput,
} from "../../shopify/mutations/content";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ConflictStrategy, PageBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

export async function ensurePageItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "page" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting pages from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const op = await runBulkQuery(sourceAdmin, BULK_PAGES_QUERY);
  if (!op.url) {
    await logEvent(job.id, "INFO", "Source store has no pages to migrate");
    return;
  }

  const grouped = await collectGroupedBulkResults(op.url);
  const rows = grouped.map((record) => ({
    migrationJobId: job.id,
    resourceType: "page",
    stage: "pages",
    sourceId: (record.parent as unknown as PageBulkPayload).id,
    status: "PENDING" as const,
    payload: record.parent as unknown as object,
  }));

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} pages to migrate`);
}

interface PageCreateResponse {
  pageCreate: {
    page: { id: string; handle: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}
interface PageUpdateResponse {
  pageUpdate: {
    page: { id: string; handle: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}
interface PageByHandleResponse {
  pages: { edges: Array<{ node: { id: string; handle: string } }> };
}

export async function runPagesStage(job: MigrationJobWithConnection): Promise<void> {
  await ensurePageItems(job);

  const conflictStrategy: ConflictStrategy =
    (job.conflictStrategy as Record<string, ConflictStrategy>).pages ?? "SKIP";
  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "page", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const page = item.payload as unknown as PageBulkPayload;
    const storeConnectionId = job.storeConnectionId;

    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    const alreadyMapped = await getLiveMapping(
      destAdmin,
      storeConnectionId,
      "page",
      item.sourceId,
    );
    if (alreadyMapped) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null },
      });
      continue;
    }

    let existingDestinationId: string | null = null;
    try {
      const existing = await destAdmin.graphql<PageByHandleResponse>(
        PAGE_BY_HANDLE_QUERY,
        { query: `handle:${JSON.stringify(page.handle)}` },
        5,
      );
      existingDestinationId = existing.pages.edges[0]?.node.id ?? null;
    } catch (error) {
      await fail(job.id, item.id, `Conflict check failed: ${errMsg(error)}`);
      continue;
    }

    if (existingDestinationId && conflictStrategy === "SKIP") {
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "SKIPPED", errorMessage: "Page with this handle already exists on the destination store" },
      });
      continue;
    }

    const input: PageCreateInput = {
      title: page.title,
      handle: existingDestinationId && conflictStrategy === "CREATE_NEW" ? `${page.handle}-copy-${Date.now().toString(36)}` : page.handle,
      body: page.body,
      isPublished: page.isPublished,
      templateSuffix: page.templateSuffix ?? undefined,
    };

    try {
      const shouldUpdate = existingDestinationId !== null && conflictStrategy !== "CREATE_NEW";
      const outcome = shouldUpdate
        ? (
            await destAdmin.graphql<PageUpdateResponse>(
            PAGE_UPDATE_MUTATION,
            {
              id: existingDestinationId,
              page: input satisfies PageUpdateInput,
            },
            10,
          )
          ).pageUpdate
        : (await destAdmin.graphql<PageCreateResponse>(PAGE_CREATE_MUTATION, { page: input }, 10)).pageCreate;
      if (outcome.userErrors.length > 0 || !outcome.page) {
        await fail(job.id, item.id, joinUserErrors(outcome.userErrors, `Unknown page${shouldUpdate ? "Update" : "Create"} error`));
        continue;
      }
      const destinationId = outcome.page.id;
      await saveMapping({ storeConnectionId, resourceType: "page", sourceId: item.sourceId, destinationId, sourceHandle: page.handle, destinationHandle: outcome.page.handle });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
      await logEvent(job.id, "INFO", `${shouldUpdate ? "Updated" : "Migrated"} page "${page.title}"`, { sourceId: item.sourceId });
    } catch (error) {
      await fail(job.id, item.id, errMsg(error));
    }
  }
}

async function fail(migrationJobId: string, itemId: string, message: string): Promise<void> {
  await db.migrationItem.update({ where: { id: itemId }, data: { status: "FAILED", errorMessage: message } });
  await logEvent(migrationJobId, "ERROR", message, { itemId });
}
function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
