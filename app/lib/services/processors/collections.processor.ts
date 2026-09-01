import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import { BULK_COLLECTIONS_QUERY, COLLECTION_BY_HANDLE_QUERY } from "../../shopify/queries/collections";
import {
  COLLECTION_ADD_PRODUCTS_MUTATION,
  COLLECTION_CREATE_MUTATION,
  COLLECTION_UPDATE_MUTATION,
  type CollectionCreateInput,
  type CollectionUpdateInput,
} from "../../shopify/mutations/collections";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { CollectionBulkPayload, ConflictStrategy, ProductBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

// Runs last: needs the Products stage's IdMapping entries to translate a
// collection's member product ids from source to destination.

export async function ensureCollectionItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({
    where: { migrationJobId: job.id, resourceType: "collection" },
  });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting collections from source store");

  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const op = await runBulkQuery(sourceAdmin, BULK_COLLECTIONS_QUERY);
  if (!op.url) {
    await logEvent(job.id, "INFO", "Source store has no collections to migrate");
    return;
  }

  const grouped = await collectGroupedBulkResults(op.url);

  const rows = grouped.map((record) => ({
    migrationJobId: job.id,
    resourceType: "collection",
    stage: "collections",
    sourceId: (record.parent as unknown as CollectionBulkPayload).id,
    status: "PENDING" as const,
    payload: record.parent as unknown as object,
  }));

  if (rows.length > 0) {
    await db.migrationItem.createMany({ data: rows });
  }
  await logEvent(job.id, "INFO", `Found ${rows.length} collections to migrate`);
}

interface CollectionCreateResponse {
  collectionCreate: {
    collection: { id: string; handle: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}
interface CollectionUpdateResponse {
  collectionUpdate: {
    collection: { id: string; handle: string } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

interface CollectionByHandleResponse {
  collections: { edges: Array<{ node: { id: string; handle: string } }> };
}

export async function runCollectionsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureCollectionItems(job);

  const conflictStrategy: ConflictStrategy =
    (job.conflictStrategy as Record<string, ConflictStrategy>).collections ?? "SKIP";

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "collection",
      status: { in: ["PENDING", "RETRYING"] },
    },
  });

  // Include SKIPPED products that still have a destination mapping so manual
  // collection membership (and inventory) keep working after skip-on-conflict.
  const productItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "product",
      status: { in: ["COMPLETED", "SKIPPED"] },
      destinationId: { not: null },
    },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    await processCollectionItem(job, item, destAdmin, conflictStrategy, productItems);
  }
}

async function processCollectionItem(
  job: MigrationJobWithConnection,
  item: { id: string; sourceId: string; attempt: number; payload: unknown },
  destAdmin: ReturnType<typeof createAdminClient>,
  conflictStrategy: ConflictStrategy,
  productItems: Array<{ sourceId: string; destinationId: string | null; payload: unknown }>,
): Promise<void> {
  const collection = item.payload as unknown as CollectionBulkPayload;
  const storeConnectionId = job.storeConnectionId;

  await db.migrationItem.update({
    where: { id: item.id },
    data: { status: "PROCESSING", attempt: item.attempt + 1 },
  });

  const alreadyMapped = await getLiveMapping(
    destAdmin,
    storeConnectionId,
    "collection",
    item.sourceId,
  );
  let destinationId = alreadyMapped?.destinationId ?? null;
  let skippedExisting = false;

  if (!destinationId) {
    let existingDestinationId: string | null = null;
    try {
      const existing = await destAdmin.graphql<CollectionByHandleResponse>(
        COLLECTION_BY_HANDLE_QUERY,
        { query: `handle:${JSON.stringify(collection.handle)}` },
        5,
      );
      existingDestinationId = existing.collections.edges[0]?.node.id ?? null;
    } catch (error) {
      await fail(job.id, item.id, `Conflict check failed: ${errMsg(error)}`);
      return;
    }

    if (existingDestinationId && conflictStrategy === "SKIP") {
      await saveMapping({
        storeConnectionId,
        resourceType: "collection",
        sourceId: item.sourceId,
        destinationId: existingDestinationId,
        sourceHandle: collection.handle,
        destinationHandle: collection.handle,
      });
      destinationId = existingDestinationId;
      skippedExisting = true;
      await db.migrationItem.update({
        where: { id: item.id },
        data: {
          status: "SKIPPED",
          destinationId: existingDestinationId,
          errorMessage: "Collection with this handle already exists on the destination store",
        },
      });
    } else {
      const input: CollectionCreateInput = {
        title: collection.title,
        handle:
          existingDestinationId && conflictStrategy === "CREATE_NEW"
            ? `${collection.handle}-copy-${Date.now().toString(36)}`
            : collection.handle,
        descriptionHtml: collection.descriptionHtml ?? undefined,
        sortOrder: collection.sortOrder ?? undefined,
        templateSuffix: collection.templateSuffix ?? undefined,
        image: collection.image
          ? { src: collection.image.url, altText: collection.image.altText ?? undefined }
          : undefined,
        ruleSet: collection.ruleSet
          ? {
              appliedDisjunctively: collection.ruleSet.appliedDisjunctively,
              rules: collection.ruleSet.rules,
            }
          : undefined,
      };

      try {
        const shouldUpdate =
          existingDestinationId !== null && conflictStrategy !== "CREATE_NEW";
        const outcome = shouldUpdate
          ? (
              await destAdmin.graphql<CollectionUpdateResponse>(
                COLLECTION_UPDATE_MUTATION,
                {
                  input: {
                    ...input,
                    id: existingDestinationId!,
                  } satisfies CollectionUpdateInput,
                },
                20,
              )
            ).collectionUpdate
          : (
              await destAdmin.graphql<CollectionCreateResponse>(
                COLLECTION_CREATE_MUTATION,
                { input },
                20,
              )
            ).collectionCreate;

        if (outcome.userErrors.length > 0 || !outcome.collection) {
          const message = joinUserErrors(
            outcome.userErrors,
            `Unknown collection${shouldUpdate ? "Update" : "Create"} error`,
          );
          await fail(job.id, item.id, message);
          return;
        }

        destinationId = outcome.collection.id;
        await saveMapping({
          storeConnectionId,
          resourceType: "collection",
          sourceId: item.sourceId,
          destinationId,
          sourceHandle: collection.handle,
          destinationHandle: outcome.collection.handle,
        });

        const { publishToOnlineStore } = await import("../../shopify/publications");
        const published = await publishToOnlineStore(destAdmin, destinationId);
        if (!published.ok) {
          await logEvent(
            job.id,
            "WARN",
            `Collection "${collection.title}" migrated but not published: ${published.message ?? "unknown"}`,
            { sourceId: item.sourceId, destinationId },
          );
        }
      } catch (error) {
        await fail(job.id, item.id, errMsg(error));
        return;
      }
    }
  }

  // Manual collections carry an explicit product list; smart collections
  // (ruleSet present) populate themselves from their rules, so skip membership.
  if (!collection.ruleSet && destinationId) {
    const memberDestinationIds = productItems
      .filter((p) => {
        const payload = p.payload as unknown as ProductBulkPayload;
        return payload.collectionIds.includes(collection.id) && p.destinationId;
      })
      .map((p) => p.destinationId as string);

    if (memberDestinationIds.length > 0) {
      try {
        await destAdmin.graphql(
          COLLECTION_ADD_PRODUCTS_MUTATION,
          { id: destinationId, productIds: memberDestinationIds },
          Math.ceil(memberDestinationIds.length / 5) + 5,
        );
      } catch (error) {
        await logEvent(
          job.id,
          "WARN",
          `Collection "${collection.title}" created but adding products failed: ${errMsg(error)}`,
        );
      }
    }
  }

  if (skippedExisting) {
    await logEvent(job.id, "INFO", `Linked existing collection "${collection.title}"`, {
      sourceId: item.sourceId,
      destinationId,
    });
    return;
  }

  await db.migrationItem.update({
    where: { id: item.id },
    data: { status: "COMPLETED", destinationId, errorMessage: null },
  });
  await logEvent(job.id, "INFO", `Migrated collection "${collection.title}"`, {
    sourceId: item.sourceId,
    destinationId,
  });
}

async function fail(migrationJobId: string, itemId: string, message: string): Promise<void> {
  await db.migrationItem.update({
    where: { id: itemId },
    data: { status: "FAILED", errorMessage: message },
  });
  await logEvent(migrationJobId, "ERROR", message, { itemId });
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
