import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { DISCOUNT_CODE_NODES_QUERY } from "../../shopify/queries/discounts";
import { DISCOUNT_CODE_BASIC_CREATE_MUTATION, type DiscountCodeBasicInput } from "../../shopify/mutations/discounts";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { DiscountBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

interface DiscountCodeNodesResponse {
  codeDiscountNodes: {
    edges: Array<{
      node: {
        id: string;
        codeDiscount: {
          __typename: string;
          title?: string;
          startsAt?: string;
          endsAt?: string | null;
          appliesOncePerCustomer?: boolean;
          codes?: { edges: Array<{ node: { code: string } }> };
          customerGets?: { value: { percentage?: number; amount?: { amount: string } } };
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function ensureDiscountItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "discount" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting discount codes from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);

  const rows: Array<{ migrationJobId: string; resourceType: string; stage: string; sourceId: string; status: "PENDING" | "SKIPPED"; errorMessage?: string; payload: object }> = [];
  let after: string | null = null;
  do {
    const result: DiscountCodeNodesResponse = await sourceAdmin.graphql<DiscountCodeNodesResponse>(DISCOUNT_CODE_NODES_QUERY, { after }, 15);
    for (const edge of result.codeDiscountNodes.edges) {
      const cd = edge.node.codeDiscount;
      if (cd.__typename !== "DiscountCodeBasic") {
        rows.push({
          migrationJobId: job.id,
          resourceType: "discount",
          stage: "discounts",
          sourceId: edge.node.id,
          status: "SKIPPED",
          errorMessage: `Discount type ${cd.__typename} is not supported yet (only basic percentage/fixed-amount code discounts migrate)`,
          payload: { unsupportedType: cd.__typename } as object,
        });
        continue;
      }

      const value = cd.customerGets?.value;
      const payload: DiscountBulkPayload = {
        id: edge.node.id,
        title: cd.title ?? "Discount",
        code: cd.codes?.edges[0]?.node.code ?? null,
        startsAt: cd.startsAt ?? new Date().toISOString(),
        endsAt: cd.endsAt ?? null,
        valueType: value?.percentage !== undefined ? "PERCENTAGE" : "FIXED_AMOUNT",
        value: value?.percentage !== undefined ? value.percentage : Number(value?.amount?.amount ?? 0),
        appliesOncePerCustomer: cd.appliesOncePerCustomer ?? false,
      };

      rows.push({
        migrationJobId: job.id,
        resourceType: "discount",
        stage: "discounts",
        sourceId: edge.node.id,
        status: "PENDING",
        payload: payload as unknown as object,
      });
    }
    after = result.codeDiscountNodes.pageInfo.hasNextPage ? result.codeDiscountNodes.pageInfo.endCursor : null;
  } while (after);

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} discount codes to migrate`);
}

interface DiscountCreateResponse {
  discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}

export async function runDiscountsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureDiscountItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "discount", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const discount = item.payload as unknown as DiscountBulkPayload;
    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    const alreadyMapped = await getLiveMapping(destAdmin, job.storeConnectionId, "discount", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null } });
      continue;
    }

    if (!discount.code) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", errorMessage: "Discount has no code" } });
      continue;
    }

    const input: DiscountCodeBasicInput = {
      title: discount.title,
      code: discount.code,
      startsAt: discount.startsAt,
      endsAt: discount.endsAt ?? undefined,
      appliesOncePerCustomer: discount.appliesOncePerCustomer,
      customerGets: {
        value:
          discount.valueType === "PERCENTAGE"
            ? { percentage: discount.value / 100 }
            : { discountAmount: { amount: String(discount.value), appliesOnEachItem: false } },
        items: { all: true },
      },
      customerSelection: { all: true },
    };

    try {
      const result = await destAdmin.graphql<DiscountCreateResponse>(DISCOUNT_CODE_BASIC_CREATE_MUTATION, { basicCodeDiscount: input }, 10);
      if (result.discountCodeBasicCreate.userErrors.length > 0 || !result.discountCodeBasicCreate.codeDiscountNode) {
        const message = joinUserErrors(result.discountCodeBasicCreate?.userErrors, "Unknown discountCodeBasicCreate error");
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      const destinationId = result.discountCodeBasicCreate.codeDiscountNode.id;
      await saveMapping({ storeConnectionId: job.storeConnectionId, resourceType: "discount", sourceId: item.sourceId, destinationId });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
    }
  }
}
