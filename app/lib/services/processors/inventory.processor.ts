import db from "../../../db.server";
import { createAdminClient, type AdminClient } from "../../shopify/admin-client";
import { runBulkQuery, streamBulkResults } from "../../shopify/bulk-operations";
import { BULK_INVENTORY_QUERY, LOCATIONS_QUERY } from "../../shopify/queries/inventory";
import { INVENTORY_SET_QUANTITIES_MUTATION, type InventorySetQuantitiesInput } from "../../shopify/mutations/inventory";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

interface InventoryItemPayload {
  variantSourceId: string;
  levels: Array<{ locationName: string; quantity: number }>;
}

interface LocationsResponse {
  locations: { edges: Array<{ node: { id: string; name: string } }> };
}

async function fetchLocationsByName(admin: AdminClient): Promise<Map<string, string>> {
  const result = await admin.graphql<LocationsResponse>(LOCATIONS_QUERY, undefined, 5);
  return new Map(
    (result.locations?.edges ?? []).map((e) => [e.node.name, e.node.id]),
  );
}

// Bulk-exports every variant's inventory item + levels. inventoryItem is a
// singular field on the variant (not a connection), but its nested
// inventoryLevels connection still gets flattened by Shopify's bulk export
// with __parentId pointing at the *inventoryItem's* id, not the variant's —
// so this does its own two-pass grouping rather than the generic
// collectGroupedBulkResults helper (which only handles one level).
export async function ensureInventoryItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "inventory" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting inventory levels from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const op = await runBulkQuery(sourceAdmin, BULK_INVENTORY_QUERY);
  if (!op.url) {
    await logEvent(job.id, "INFO", "Source store has no inventory data to migrate");
    return;
  }

  const variantByInvItem = new Map<string, string>(); // inventoryItemId -> variantId
  const levelsByInvItem = new Map<string, Array<{ locationName: string; quantity: number }>>();

  for await (const record of streamBulkResults(op.url)) {
    if (!record.__parentId) {
      // top-level productVariants node
      const invItem = record.inventoryItem as { id: string } | undefined;
      if (invItem?.id) variantByInvItem.set(invItem.id, record.id as string);
    } else {
      // inventoryLevel node, parented to the inventoryItem
      const invItemId = record.__parentId as string;
      const location = record.location as { name: string } | undefined;
      const quantities = record.quantities as Array<{ name: string; quantity: number }> | undefined;
      const available = quantities?.find((q) => q.name === "available")?.quantity;
      if (!location || available === undefined) continue;
      const list = levelsByInvItem.get(invItemId) ?? [];
      list.push({ locationName: location.name, quantity: available });
      levelsByInvItem.set(invItemId, list);
    }
  }

  const rows: Array<{ migrationJobId: string; resourceType: string; stage: string; sourceId: string; status: "PENDING"; payload: object }> = [];
  for (const [invItemId, variantId] of variantByInvItem) {
    const levels = levelsByInvItem.get(invItemId);
    if (!levels || levels.length === 0) continue;
    const payload: InventoryItemPayload = { variantSourceId: variantId, levels };
    rows.push({
      migrationJobId: job.id,
      resourceType: "inventory",
      stage: "inventory",
      sourceId: variantId,
      status: "PENDING",
      payload: payload as unknown as object,
    });
  }

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found inventory data for ${rows.length} variants to migrate`);
}

interface VariantInventoryItemResponse {
  productVariant: { inventoryItem: { id: string } } | null;
}

interface SetQuantitiesResponse {
  inventorySetQuantities: { userErrors: Array<{ field: string[]; message: string }> };
}

export async function runInventoryStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureInventoryItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);

  const [sourceLocations, destLocations] = await Promise.all([
    fetchLocationsByName(sourceAdmin),
    fetchLocationsByName(destAdmin),
  ]);
  void sourceLocations; // kept for parity/debugging; matching is by location *name*

  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "inventory", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const payload = item.payload as unknown as InventoryItemPayload;
    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    const variantMapping = await getLiveMapping(
      destAdmin,
      job.storeConnectionId,
      "variant",
      payload.variantSourceId,
    );
    if (!variantMapping) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", errorMessage: "Variant was not migrated (skipped or failed)" } });
      continue;
    }

    let inventoryItemId: string;
    try {
      const result = await destAdmin.graphql<VariantInventoryItemResponse>(
        `#graphql
          query duplifyVariantInventoryItem($id: ID!) {
            productVariant(id: $id) { inventoryItem { id } }
          }
        `,
        { id: variantMapping.destinationId },
        5,
      );
      if (!result.productVariant) throw new Error("Destination variant not found");
      inventoryItemId = result.productVariant.inventoryItem.id;
    } catch (error) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: errMsg(error) } });
      continue;
    }

    const quantities = payload.levels
      .map((level) => {
        const locationId = destLocations.get(level.locationName);
        return locationId ? { inventoryItemId, locationId, quantity: level.quantity } : null;
      })
      .filter((q): q is NonNullable<typeof q> => q !== null);

    if (quantities.length === 0) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "SKIPPED", errorMessage: "No matching location name found on destination store" },
      });
      continue;
    }

    const input: InventorySetQuantitiesInput = {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities,
    };

    try {
      const result = await destAdmin.graphql<SetQuantitiesResponse>(INVENTORY_SET_QUANTITIES_MUTATION, { input }, 15);
      const setResult = result.inventorySetQuantities;
      if ((setResult?.userErrors?.length ?? 0) > 0) {
        const message = joinUserErrors(
          setResult?.userErrors,
          "Unknown inventorySetQuantities error",
        );
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      if (!setResult) {
        await db.migrationItem.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            errorMessage: "inventorySetQuantities payload missing",
          },
        });
        continue;
      }
      await saveMapping({ storeConnectionId: job.storeConnectionId, resourceType: "inventory", sourceId: item.sourceId, destinationId: inventoryItemId });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: inventoryItemId, errorMessage: null } });
    } catch (error) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: errMsg(error) } });
    }
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
