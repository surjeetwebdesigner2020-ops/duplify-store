import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import { BULK_ORDERS_QUERY } from "../../shopify/queries/orders";
import { DRAFT_ORDER_CREATE_MUTATION, type DraftOrderInput } from "../../shopify/mutations/orders";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { OrderBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

export async function ensureOrderItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "order" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting orders from source store (will be recreated as draft orders — see Documentation)");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const op = await runBulkQuery(sourceAdmin, BULK_ORDERS_QUERY);
  if (!op.url) {
    await logEvent(job.id, "INFO", "Source store has no orders to migrate");
    return;
  }

  const grouped = await collectGroupedBulkResults(op.url);
  const rows = grouped.map((record) => {
    const order = record.parent as Record<string, unknown>;
    const lineItems = (record.childrenByField.LineItem ?? []) as Array<Record<string, unknown>>;

    const payload: OrderBulkPayload = {
      id: order.id as string,
      name: order.name as string,
      email: (order.email as string | null) ?? null,
      customerSourceId: (order.customer as { id: string } | null)?.id ?? null,
      currencyCode: order.currencyCode as string,
      note: (order.note as string | null) ?? null,
      tags: (order.tags as string[]) ?? [],
      lineItems: lineItems.map((li) => ({
        title: li.title as string,
        quantity: li.quantity as number,
        sku: (li.sku as string | null) ?? null,
        productVariantSourceId: (li.variant as { id: string } | null)?.id ?? null,
      })),
      shippingAddress: order.shippingAddress as OrderBulkPayload["shippingAddress"],
    };

    return {
      migrationJobId: job.id,
      resourceType: "order",
      stage: "orders",
      sourceId: payload.id,
      status: "PENDING" as const,
      payload: payload as unknown as object,
    };
  });

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} orders to migrate as draft orders`);
}

interface DraftOrderCreateResponse {
  draftOrderCreate: { draftOrder: { id: string; name: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}

export async function runOrdersStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureOrderItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "order", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const order = item.payload as unknown as OrderBulkPayload;
    const storeConnectionId = job.storeConnectionId;

    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    const alreadyMapped = await getLiveMapping(destAdmin, storeConnectionId, "order", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null } });
      continue;
    }

    let customerId: string | undefined;
    if (order.customerSourceId) {
      const mapping = await getLiveMapping(destAdmin, storeConnectionId, "customer", order.customerSourceId);
      customerId = mapping?.destinationId;
    }

    const lineItems = [];
    for (const li of order.lineItems) {
      let variantId: string | undefined;
      if (li.productVariantSourceId) {
        const mapping = await getLiveMapping(destAdmin, storeConnectionId, "variant", li.productVariantSourceId);
        variantId = mapping?.destinationId;
      }
      lineItems.push(variantId ? { variantId, quantity: li.quantity } : { title: li.title, quantity: li.quantity });
    }

    if (lineItems.length === 0) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", errorMessage: "Order has no line items" } });
      continue;
    }

    const input: DraftOrderInput = {
      email: order.email ?? undefined,
      note2: order.note ? `Migrated from ${order.name} (Duplify Store): ${order.note}` : `Migrated from ${order.name} (Duplify Store)`,
      tags: order.tags,
      customerId,
      shippingAddress: order.shippingAddress
        ? {
            address1: order.shippingAddress.address1 ?? undefined,
            address2: order.shippingAddress.address2 ?? undefined,
            city: order.shippingAddress.city ?? undefined,
            provinceCode: order.shippingAddress.provinceCode ?? undefined,
            countryCode: order.shippingAddress.countryCodeV2 ?? undefined,
            zip: order.shippingAddress.zip ?? undefined,
            firstName: order.shippingAddress.firstName ?? undefined,
            lastName: order.shippingAddress.lastName ?? undefined,
          }
        : undefined,
      lineItems,
    };

    try {
      const result = await destAdmin.graphql<DraftOrderCreateResponse>(DRAFT_ORDER_CREATE_MUTATION, { input }, 20);
      if (result.draftOrderCreate.userErrors.length > 0 || !result.draftOrderCreate.draftOrder) {
        const message = joinUserErrors(result.draftOrderCreate?.userErrors, "Unknown draftOrderCreate error");
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      const destinationId = result.draftOrderCreate.draftOrder.id;
      await saveMapping({ storeConnectionId, resourceType: "order", sourceId: item.sourceId, destinationId });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
      await logEvent(job.id, "INFO", `Migrated order ${order.name} as draft order ${result.draftOrderCreate.draftOrder.name}`, { sourceId: item.sourceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
    }
  }
}
