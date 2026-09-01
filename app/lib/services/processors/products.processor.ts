import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import { PRODUCT_BY_HANDLE_QUERY, BULK_PRODUCTS_QUERY, PRODUCTS_PAGE_QUERY } from "../../shopify/queries/products";
import {
  PRODUCT_SET_MUTATION,
  type ProductSetInput,
} from "../../shopify/mutations/products";
import {
  METAFIELDS_SET_MUTATION,
  type MetafieldsSetInput,
} from "../../shopify/mutations/metafields";
import {
  deleteMapping,
  getLiveMapping,
  getMapping,
  getMappingBySourceIdAnyType,
  saveMapping,
} from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ConflictStrategy, ProductBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import {
  buildVariantInputs,
  recordFailedVariantItems,
  recordVariantMigrationItems,
} from "./variants.processor";
import { joinUserErrors } from "../../shopify/graphql-safe";

export const MAX_ATTEMPTS = 3;

// Populates one MigrationItem per source product (status PENDING) the first
// time the products stage runs for this job. Safe to call again on retry —
// it no-ops once items already exist, so re-running a stage never duplicates
// the item list.
export async function ensureProductItems(
  job: MigrationJobWithConnection,
): Promise<void> {
  const existing = await db.migrationItem.count({
    where: { migrationJobId: job.id, resourceType: "product" },
  });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting products from source store");

  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  let grouped: Array<{ parent: Record<string, unknown>; childrenByField: Record<string, Record<string, unknown>[]> }>;
  try {
    const op = await runBulkQuery(sourceAdmin, BULK_PRODUCTS_QUERY);
    if (!op.url) {
      await logEvent(job.id, "INFO", "Source store has no products to migrate");
      return;
    }
    grouped = await collectGroupedBulkResults(op.url);
  } catch (error) {
    await logEvent(job.id, "WARN", `Product bulk export failed; falling back to paginated export: ${errMsg(error)}`);
    grouped = await fetchProductsByPages(sourceAdmin);
  }

  const rows = grouped.map((record) => {
    const payload: ProductBulkPayload = {
      parent: record.parent as unknown as ProductBulkPayload["parent"],
      variants: (record.childrenByField.ProductVariant ?? []) as unknown as ProductBulkPayload["variants"],
      media: (record.childrenByField.MediaImage ?? []) as unknown as ProductBulkPayload["media"],
      metafields: (record.childrenByField.Metafield ?? []) as unknown as ProductBulkPayload["metafields"],
      collectionIds: (record.childrenByField.Collection ?? []).map(
        (c) => c.id as string,
      ),
    };

    return {
      migrationJobId: job.id,
      resourceType: "product",
      stage: "products",
      sourceId: payload.parent.id,
      status: "PENDING" as const,
      payload: payload as unknown as object,
    };
  });

  if (rows.length > 0) {
    await db.migrationItem.createMany({ data: rows });
  }

  await logEvent(job.id, "INFO", `Found ${rows.length} products to migrate`);
}

interface ProductsPageResponse {
  products: {
    edges: Array<{
      node: ProductBulkPayload["parent"] & {
        variants: { edges: Array<{ node: ProductBulkPayload["variants"][number] }> };
        media: { edges: Array<{ node: ProductBulkPayload["media"][number] }> };
        metafields: { edges: Array<{ node: ProductBulkPayload["metafields"][number] }> };
        collections: { edges: Array<{ node: { id: string } }> };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function fetchProductsByPages(
  sourceAdmin: ReturnType<typeof createAdminClient>,
): Promise<Array<{ parent: Record<string, unknown>; childrenByField: Record<string, Record<string, unknown>[]> }>> {
  const grouped: Array<{ parent: Record<string, unknown>; childrenByField: Record<string, Record<string, unknown>[]> }> = [];
  let after: string | null = null;

  do {
    const result: ProductsPageResponse = await sourceAdmin.graphql<ProductsPageResponse>(PRODUCTS_PAGE_QUERY, { after }, 50);
    for (const edge of result.products?.edges ?? []) {
      const { variants, media, metafields, collections, ...parent } = edge.node;
      grouped.push({
        parent: parent as unknown as Record<string, unknown>,
        childrenByField: {
          ProductVariant: (variants?.edges ?? []).map(
            (variant: { node: ProductBulkPayload["variants"][number] }) =>
              variant.node as unknown as Record<string, unknown>,
          ),
          MediaImage: (media?.edges ?? []).map(
            (m: { node: ProductBulkPayload["media"][number] }) =>
              m.node as unknown as Record<string, unknown>,
          ),
          Metafield: (metafields?.edges ?? []).map(
            (m: { node: ProductBulkPayload["metafields"][number] }) =>
              m.node as unknown as Record<string, unknown>,
          ),
          Collection: (collections?.edges ?? []).map(
            (collection: { node: { id: string } }) =>
              collection.node as unknown as Record<string, unknown>,
          ),
        },
      });
    }
    after = result.products?.pageInfo?.hasNextPage
      ? result.products.pageInfo.endCursor
      : null;
  } while (after);

  return grouped;
}

export async function runProductsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureProductItems(job);

  const conflictStrategy: ConflictStrategy =
    (job.conflictStrategy as Record<string, ConflictStrategy>).products ?? "SKIP";

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "product",
      status: { in: ["PENDING", "RETRYING"] },
    },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    await processProductItem(job, item, destAdmin, conflictStrategy);
  }
}

interface ProductSetResponse {
  productSet: {
    product: {
      id: string;
      handle: string;
      variants: { edges: Array<{ node: { id: string; sku: string | null; selectedOptions: Array<{ name: string; value: string }> } }> };
    } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

interface ProductByHandleResponse {
  products: {
    edges: Array<{
      node: {
        id: string;
        handle: string;
        variants: {
          edges: Array<{
            node: {
              id: string;
              sku: string | null;
              selectedOptions: Array<{ name: string; value: string }>;
            };
          }>;
        };
      };
    }>;
  };
}

async function processProductItem(
  job: MigrationJobWithConnection,
  item: { id: string; sourceId: string; attempt: number; payload: unknown },
  destAdmin: ReturnType<typeof createAdminClient>,
  conflictStrategy: ConflictStrategy,
): Promise<void> {
  const payload = item.payload as unknown as ProductBulkPayload;
  const storeConnectionId = job.storeConnectionId;

  await db.migrationItem.update({
    where: { id: item.id },
    data: { status: "PROCESSING", attempt: item.attempt + 1 },
  });

  // Only clear child variant mappings when we dropped a stale product mapping.
  const priorMapping = await getMapping(storeConnectionId, "product", item.sourceId);
  const alreadyMapped = await getLiveMapping(
    destAdmin,
    storeConnectionId,
    "product",
    item.sourceId,
  );
  if (alreadyMapped) {
    await db.migrationItem.update({
      where: { id: item.id },
      data: {
        status: "COMPLETED",
        destinationId: alreadyMapped.destinationId,
        errorMessage: null,
      },
    });
    return;
  }

  if (priorMapping && !alreadyMapped) {
    await logEvent(
      job.id,
      "WARN",
      `Destination product for "${payload.parent.handle}" was deleted — recreating`,
      { sourceId: item.sourceId },
    );
    for (const variant of payload.variants) {
      await deleteMapping(storeConnectionId, "variant", variant.id);
    }
  }

  let existingNode: ProductByHandleResponse["products"]["edges"][number]["node"] | null =
    null;
  try {
    const existing = await destAdmin.graphql<ProductByHandleResponse>(
      PRODUCT_BY_HANDLE_QUERY,
      { query: `handle:${JSON.stringify(payload.parent.handle)}` },
      5,
    );
    existingNode = existing.products.edges[0]?.node ?? null;
  } catch (error) {
    await failItem(job.id, item.id, item.attempt, `Conflict check failed: ${errMsg(error)}`);
    return;
  }

  const existingDestinationId = existingNode?.id ?? null;

  if (existingDestinationId && conflictStrategy === "SKIP") {
    await saveMapping({
      storeConnectionId,
      resourceType: "product",
      sourceId: item.sourceId,
      destinationId: existingDestinationId,
      sourceHandle: payload.parent.handle,
      destinationHandle: payload.parent.handle,
    });
    // Map variants onto the existing destination product so inventory/orders
    // still resolve after a skip-on-conflict.
    await recordVariantMigrationItems({
      migrationJobId: job.id,
      storeConnectionId,
      productSourceId: item.sourceId,
      sourceVariants: payload.variants,
      createdVariants: (existingNode?.variants.edges ?? []).map((e) => e.node),
    });
    await db.migrationItem.update({
      where: { id: item.id },
      data: {
        status: "SKIPPED",
        destinationId: existingDestinationId,
        errorMessage: "Product with this handle already exists on the destination store",
      },
    });
    await logEvent(job.id, "WARN", `Skipped product "${payload.parent.handle}" (already exists)`, {
      sourceId: item.sourceId,
    });
    return;
  }

  const input: ProductSetInput = {
    id: existingDestinationId && conflictStrategy !== "CREATE_NEW" ? existingDestinationId : undefined,
    title: payload.parent.title,
    handle:
      existingDestinationId && conflictStrategy === "CREATE_NEW"
        ? `${payload.parent.handle}-copy-${Date.now().toString(36)}`
        : payload.parent.handle,
    descriptionHtml: payload.parent.descriptionHtml ?? undefined,
    vendor: payload.parent.vendor ?? undefined,
    productType: payload.parent.productType ?? undefined,
    tags: payload.parent.tags,
    status: (payload.parent.status as ProductSetInput["status"]) ?? "DRAFT",
    templateSuffix: payload.parent.templateSuffix ?? undefined,
    seo: payload.parent.seo
      ? {
          title: payload.parent.seo.title ?? undefined,
          description: payload.parent.seo.description ?? undefined,
        }
      : undefined,
    productOptions:
      payload.parent.options?.map((option) => ({
        name: option.name,
        position: option.position,
        values: option.values.map((value) => ({ name: value })),
      })) ?? undefined,
    variants: buildVariantInputs(payload),
  };

  let result: ProductSetResponse;
  try {
    result = await destAdmin.graphql<ProductSetResponse>(
      PRODUCT_SET_MUTATION,
      { input, synchronous: true },
      100,
    );
  } catch (error) {
    await failItem(job.id, item.id, item.attempt, `productSet request failed: ${errMsg(error)}`);
    await recordFailedVariantItems({
      migrationJobId: job.id,
      productSourceId: item.sourceId,
      sourceVariants: payload.variants,
      errorMessage: "Parent product failed to create",
    });
    return;
  }

  if (
    !result.productSet ||
    (result.productSet.userErrors?.length ?? 0) > 0 ||
    !result.productSet.product
  ) {
    const message = joinUserErrors(
      result.productSet?.userErrors,
      "Unknown productSet error",
    );
    await failItem(job.id, item.id, item.attempt, message);
    await recordFailedVariantItems({
      migrationJobId: job.id,
      productSourceId: item.sourceId,
      sourceVariants: payload.variants,
      errorMessage: "Parent product failed to create",
    });
    return;
  }

  const product = result.productSet.product;

  await saveMapping({
    storeConnectionId,
    resourceType: "product",
    sourceId: item.sourceId,
    destinationId: product.id,
    sourceHandle: payload.parent.handle,
    destinationHandle: product.handle,
  });

  // productSet treats metafields as a replacement list. Setting them here,
  // one at a time, prevents app-owned/reference fields from failing the whole
  // product and preserves any unrelated destination metafields.
  await migrateProductMetafields(job, destAdmin, product.id, payload);

  await db.migrationItem.update({
    where: { id: item.id },
    data: { status: "COMPLETED", destinationId: product.id, errorMessage: null },
  });

  await recordVariantMigrationItems({
    migrationJobId: job.id,
    storeConnectionId,
    productSourceId: item.sourceId,
    sourceVariants: payload.variants,
    createdVariants: (product.variants?.edges ?? []).map((e) => e.node),
  });

  // ACTIVE products still need an Online Store publication or Channels stays 0.
  if ((payload.parent.status ?? "DRAFT") === "ACTIVE") {
    const { publishToOnlineStore } = await import("../../shopify/publications");
    const published = await publishToOnlineStore(destAdmin, product.id);
    if (!published.ok) {
      await logEvent(
        job.id,
        "WARN",
        `Product "${payload.parent.title}" migrated but not published to Online Store: ${published.message ?? "unknown"}`,
        { sourceId: item.sourceId, destinationId: product.id },
      );
    }
  }

  await logEvent(job.id, "INFO", `Migrated product "${payload.parent.title}"`, {
    sourceId: item.sourceId,
    destinationId: product.id,
  });
}

interface MetafieldsSetResponse {
  metafieldsSet: {
    userErrors?: unknown;
  } | null;
}

function canMigrateProductMetafield(metafield: ProductBulkPayload["metafields"][number]) {
  const namespace = metafield.namespace.trim().toLowerCase();
  const type = metafield.type.trim().toLowerCase();

  // An app cannot recreate fields owned by Shopify or another app, and source
  // GIDs in reference fields are invalid on the destination store.
  return (
    namespace.length > 0 &&
    metafield.key.trim().length > 0 &&
    type.length > 0 &&
    metafield.value != null &&
    !namespace.startsWith("app--") &&
    !namespace.startsWith("$app") &&
    namespace !== "shopify" &&
    // Reference values contain source-store GIDs. They are applied in the
    // final backfill pass, after every selected resource has been mapped.
    !type.includes("reference")
  );
}

function canMigrateProductReferenceMetafield(
  metafield: ProductBulkPayload["metafields"][number],
) {
  const namespace = metafield.namespace.trim().toLowerCase();
  const type = metafield.type.trim().toLowerCase();
  return (
    namespace.length > 0 &&
    metafield.key.trim().length > 0 &&
    metafield.value != null &&
    !namespace.startsWith("app--") &&
    !namespace.startsWith("$app") &&
    namespace !== "shopify" &&
    type.includes("reference")
  );
}

export async function remapReferenceMetafieldValue(
  type: string,
  value: string,
  resolveDestinationId: (sourceId: string) => Promise<string | null>,
): Promise<string | null> {
  if (type.toLowerCase().startsWith("list.")) {
    let sourceIds: unknown;
    try {
      sourceIds = JSON.parse(value);
    } catch {
      return null;
    }
    if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "string")) {
      return null;
    }
    const destinationIds: string[] = [];
    for (const sourceId of sourceIds as string[]) {
      const destinationId = await resolveDestinationId(sourceId);
      if (!destinationId) return null;
      destinationIds.push(destinationId);
    }
    return JSON.stringify(destinationIds);
  }

  return resolveDestinationId(value);
}

async function migrateProductMetafields(
  job: MigrationJobWithConnection,
  destAdmin: ReturnType<typeof createAdminClient>,
  destinationProductId: string,
  payload: ProductBulkPayload,
): Promise<void> {
  const metafields = payload.metafields.filter(canMigrateProductMetafield);

  for (const metafield of metafields) {
    const input: MetafieldsSetInput = {
      ownerId: destinationProductId,
      namespace: metafield.namespace,
      key: metafield.key,
      type: metafield.type,
      value: metafield.value,
    };

    try {
      const result = await destAdmin.graphql<MetafieldsSetResponse>(
        METAFIELDS_SET_MUTATION,
        { metafields: [input] },
        10,
      );
      const errors = result.metafieldsSet?.userErrors;
      if (joinUserErrors(errors, "").length > 0) {
        await logEvent(
          job.id,
          "WARN",
          `Skipped product metafield ${metafield.namespace}.${metafield.key}: ${joinUserErrors(errors)}`,
          { sourceId: payload.parent.id, destinationId: destinationProductId },
        );
      }
    } catch (error) {
      await logEvent(
        job.id,
        "WARN",
        `Skipped product metafield ${metafield.namespace}.${metafield.key}: ${errMsg(error)}`,
        { sourceId: payload.parent.id, destinationId: destinationProductId },
      );
    }
  }
}

/**
 * Re-applies product reference metafields after all selected resources have
 * been migrated. This is essential on a re-import: a deleted destination
 * product gets a new GID, while its metaobject/reference targets may already
 * exist and remain mapped from the earlier run.
 */
export async function backfillProductReferenceMetafields(
  job: MigrationJobWithConnection,
): Promise<void> {
  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const productItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "product",
      status: { in: ["COMPLETED", "SKIPPED"] },
      destinationId: { not: null },
    },
  });

  let applied = 0;
  let skipped = 0;
  for (const item of productItems) {
    if (!item.destinationId) continue;
    const payload = item.payload as unknown as ProductBulkPayload;
    const metafields = payload.metafields.filter(canMigrateProductReferenceMetafield);

    for (const metafield of metafields) {
      const value = await remapReferenceMetafieldValue(
        metafield.type,
        metafield.value,
        (sourceId) => getMappingBySourceIdAnyType(job.storeConnectionId, sourceId),
      );
      if (!value) {
        skipped += 1;
        await logEvent(
          job.id,
          "WARN",
          `Skipped product reference metafield ${metafield.namespace}.${metafield.key}: referenced destination record is not available`,
          { sourceId: item.sourceId, destinationId: item.destinationId },
        );
        continue;
      }

      try {
        const result = await destAdmin.graphql<MetafieldsSetResponse>(
          METAFIELDS_SET_MUTATION,
          {
            metafields: [{
              ownerId: item.destinationId,
              namespace: metafield.namespace,
              key: metafield.key,
              type: metafield.type,
              value,
            } satisfies MetafieldsSetInput],
          },
          10,
        );
        const message = joinUserErrors(result.metafieldsSet?.userErrors, "");
        if (message) {
          skipped += 1;
          await logEvent(
            job.id,
            "WARN",
            `Skipped product reference metafield ${metafield.namespace}.${metafield.key}: ${message}`,
            { sourceId: item.sourceId, destinationId: item.destinationId },
          );
        } else {
          applied += 1;
        }
      } catch (error) {
        skipped += 1;
        await logEvent(
          job.id,
          "WARN",
          `Skipped product reference metafield ${metafield.namespace}.${metafield.key}: ${errMsg(error)}`,
          { sourceId: item.sourceId, destinationId: item.destinationId },
        );
      }
    }
  }

  if (applied > 0 || skipped > 0) {
    await logEvent(
      job.id,
      skipped > 0 ? "WARN" : "INFO",
      `Product reference metafield backfill finished: ${applied} applied, ${skipped} skipped`,
    );
  }
}

// Retry eligibility (attempt < MAX_ATTEMPTS) is enforced where retries are
// requested (see api.migrations.$id.retry.tsx) — this just records the
// failure against the item.
async function failItem(
  migrationJobId: string,
  itemId: string,
  _attempt: number,
  message: string,
): Promise<void> {
  await db.migrationItem.update({
    where: { id: itemId },
    data: { status: "FAILED", errorMessage: message },
  });
  await logEvent(migrationJobId, "ERROR", message, { itemId });
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
