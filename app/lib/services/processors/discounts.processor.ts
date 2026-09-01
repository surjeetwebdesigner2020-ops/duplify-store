import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { DISCOUNT_CODE_BY_CODE_QUERY, DISCOUNT_CODE_NODES_QUERY } from "../../shopify/queries/discounts";
import {
  DISCOUNT_CODE_BASIC_CREATE_MUTATION,
  DISCOUNT_CODE_BASIC_UPDATE_MUTATION,
  DISCOUNT_CODE_BXGY_CREATE_MUTATION,
  DISCOUNT_CODE_BXGY_UPDATE_MUTATION,
  DISCOUNT_CODE_FREE_SHIPPING_CREATE_MUTATION,
  DISCOUNT_CODE_FREE_SHIPPING_UPDATE_MUTATION,
  type DiscountCodeBasicInput,
  type DiscountCodeBxgyInput,
  type DiscountCodeFreeShippingInput,
} from "../../shopify/mutations/discounts";
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
          customerGets?: {
            value?: {
              percentage?: number;
              amount?: { amount: string };
              discountOnQuantity?: {
                effect?: { percentage?: number; amount?: { amount: string } };
                quantity?: { quantity?: string | number };
              };
            };
          };
          minimumRequirement?: { greaterThanOrEqualToSubtotal?: { amount?: string } };
          maximumShippingPrice?: { amount?: string };
          customerBuys?: { value?: { quantity?: string | number } };
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
      if (!["DiscountCodeBasic", "DiscountCodeFreeShipping", "DiscountCodeBxgy"].includes(cd.__typename)) {
        rows.push({
          migrationJobId: job.id,
          resourceType: "discount",
          stage: "discounts",
          sourceId: edge.node.id,
          status: "SKIPPED",
          errorMessage: `Discount type ${cd.__typename} is not supported yet (only basic, free shipping, and BXGY discounts migrate)`,
          payload: { unsupportedType: cd.__typename } as object,
        });
        continue;
      }

      const value = cd.customerGets?.value;
      let payload: DiscountBulkPayload;

      switch (cd.__typename) {
        case "DiscountCodeFreeShipping": {
          payload = {
            id: edge.node.id,
            title: cd.title ?? "Free Shipping Discount",
            code: cd.codes?.edges[0]?.node.code ?? null,
            startsAt: cd.startsAt ?? new Date().toISOString(),
            endsAt: cd.endsAt ?? null,
            appliesOncePerCustomer: cd.appliesOncePerCustomer ?? false,
            discountType: "FREE_SHIPPING",
            minimumSubtotal: cd.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount ? Number(cd.minimumRequirement.greaterThanOrEqualToSubtotal.amount) : null,
            maximumShippingPrice: cd.maximumShippingPrice?.amount ? Number(cd.maximumShippingPrice.amount) : null,
          };
          break;
        }
        case "DiscountCodeBxgy": {
          const buysQuantity = cd.customerBuys?.value?.quantity ?? "1";
          const getsQuantity = cd.customerGets?.value?.discountOnQuantity?.quantity?.quantity ?? "1";
          const getsPercentage = cd.customerGets?.value?.discountOnQuantity?.effect?.percentage ?? 0;
          payload = {
            id: edge.node.id,
            title: cd.title ?? "Buy X Get Y Discount",
            code: cd.codes?.edges[0]?.node.code ?? null,
            startsAt: cd.startsAt ?? new Date().toISOString(),
            endsAt: cd.endsAt ?? null,
            appliesOncePerCustomer: cd.appliesOncePerCustomer ?? false,
            discountType: "BXGY",
            customerBuysQuantity: Number(buysQuantity),
            customerGetsQuantity: Number(getsQuantity),
            customerGetsPercentage: getsPercentage * 100,
          };
          break;
        }
        case "DiscountCodeBasic":
        default: {
          payload = {
            id: edge.node.id,
            title: cd.title ?? "Discount",
            code: cd.codes?.edges[0]?.node.code ?? null,
            startsAt: cd.startsAt ?? new Date().toISOString(),
            endsAt: cd.endsAt ?? null,
            appliesOncePerCustomer: cd.appliesOncePerCustomer ?? false,
            discountType: "BASIC",
            valueType: value?.percentage !== undefined ? "PERCENTAGE" : "FIXED_AMOUNT",
            value: value?.percentage !== undefined ? value.percentage : Number(value?.amount?.amount ?? 0),
          };
          break;
        }
      }

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

type DiscountMutationResult = {
  codeDiscountNode: { id: string } | null;
  userErrors: Array<{ field: string[]; message: string }>;
};

interface DiscountCreateResponse {
  discountCodeBasicCreate?: DiscountMutationResult;
  discountCodeFreeShippingCreate?: DiscountMutationResult;
  discountCodeBxgyCreate?: DiscountMutationResult;
}
interface DiscountUpdateResponse {
  discountCodeBasicUpdate?: DiscountMutationResult;
  discountCodeFreeShippingUpdate?: DiscountMutationResult;
  discountCodeBxgyUpdate?: DiscountMutationResult;
}
interface DiscountByCodeResponse {
  codeDiscountNodeByCode: { id: string } | null;
}

function isDiscountSkippableError(message: string): boolean {
  return /already exists on the destination|not supported|unsupported|invalid code|code is required|requires.*code|customer gets.*invalid|customer selection.*invalid|minimum requirement|maximum shipping price|value.*required|quantity.*required|cannot.*discount/i.test(
    message,
  );
}

async function skipDiscountItem(
  job: MigrationJobWithConnection,
  itemId: string,
  message: string,
  destinationId?: string | null,
): Promise<void> {
  await db.migrationItem.update({
    where: { id: itemId },
    data: {
      status: "SKIPPED",
      destinationId: destinationId ?? null,
      errorMessage: message,
    },
  });
  await logEvent(job.id, "WARN", `Discount skipped: ${message}`, { itemId });
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

    let createMutation: string;
    let updateMutation: string;
    let createResultKey: keyof DiscountCreateResponse;
    let updateResultKey: keyof DiscountUpdateResponse;
    let createArgKey: "basicCodeDiscount" | "freeShippingCodeDiscount" | "bxgyCodeDiscount";
    let updateArgKey: "basicCodeDiscount" | "freeShippingCodeDiscount" | "bxgyCodeDiscount";
    let input: DiscountCodeBasicInput | DiscountCodeFreeShippingInput | DiscountCodeBxgyInput;

    switch (discount.discountType) {
      case "FREE_SHIPPING": {
        createMutation = DISCOUNT_CODE_FREE_SHIPPING_CREATE_MUTATION;
        updateMutation = DISCOUNT_CODE_FREE_SHIPPING_UPDATE_MUTATION;
        createResultKey = "discountCodeFreeShippingCreate";
        updateResultKey = "discountCodeFreeShippingUpdate";
        createArgKey = "freeShippingCodeDiscount";
        updateArgKey = "freeShippingCodeDiscount";
        input = {
          title: discount.title,
          code: discount.code ?? `${discount.title.replace(/\s+/g, "-").toUpperCase()}-COPY`,
          startsAt: discount.startsAt,
          endsAt: discount.endsAt ?? undefined,
          appliesOncePerCustomer: discount.appliesOncePerCustomer,
          minimumRequirement: discount.minimumSubtotal !== null ? { subtotal: { greaterThanOrEqualToSubtotal: discount.minimumSubtotal } } : undefined,
          customerSelection: { all: true },
          destination: { all: true },
          maximumShippingPrice: discount.maximumShippingPrice !== null ? { amount: String(discount.maximumShippingPrice) } : undefined,
        };
        break;
      }
      case "BXGY": {
        createMutation = DISCOUNT_CODE_BXGY_CREATE_MUTATION;
        updateMutation = DISCOUNT_CODE_BXGY_UPDATE_MUTATION;
        createResultKey = "discountCodeBxgyCreate";
        updateResultKey = "discountCodeBxgyUpdate";
        createArgKey = "bxgyCodeDiscount";
        updateArgKey = "bxgyCodeDiscount";
        input = {
          title: discount.title,
          code: discount.code ?? `${discount.title.replace(/\s+/g, "-").toUpperCase()}-COPY`,
          startsAt: discount.startsAt,
          endsAt: discount.endsAt ?? undefined,
          appliesOncePerCustomer: discount.appliesOncePerCustomer,
          customerBuys: {
            value: { quantity: String(discount.customerBuysQuantity || 1) },
            items: { all: true },
          },
          customerGets: {
            value: {
              discountOnQuantity: {
                effect: { percentage: discount.customerGetsPercentage / 100 },
                quantity: { quantity: String(discount.customerGetsQuantity || 1) },
              },
            },
            items: { all: true },
          },
          customerSelection: { all: true },
        };
        break;
      }
      case "BASIC":
      default: {
        createMutation = DISCOUNT_CODE_BASIC_CREATE_MUTATION;
        updateMutation = DISCOUNT_CODE_BASIC_UPDATE_MUTATION;
        createResultKey = "discountCodeBasicCreate";
        updateResultKey = "discountCodeBasicUpdate";
        createArgKey = "basicCodeDiscount";
        updateArgKey = "basicCodeDiscount";
        input = {
          title: discount.title,
          code: discount.code ?? `${discount.title.replace(/\s+/g, "-").toUpperCase()}-COPY`,
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
        break;
      }
    }

    try {
      const existing = await destAdmin.graphql<DiscountByCodeResponse>(
        DISCOUNT_CODE_BY_CODE_QUERY,
        { code: discount.code },
        5,
      );
      const existingId = existing.codeDiscountNodeByCode?.id ?? null;
      const conflictStrategy = (job.conflictStrategy as Record<string, string>).discounts ?? "SKIP";
      if (existingId && conflictStrategy === "SKIP") {
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", destinationId: existingId, errorMessage: "Discount code already exists on the destination store" } });
        continue;
      }

      const createPayload = existingId
        ? { ...input, code: `${input.code}-COPY-${Date.now().toString(36)}` }
        : input;
      const createVariables = { [createArgKey]: createPayload } as Record<string, unknown>;
      const updateVariables = { id: existingId, [updateArgKey]: input } as Record<string, unknown>;

      const outcome = existingId && conflictStrategy !== "CREATE_NEW"
        ? ((await destAdmin.graphql<DiscountUpdateResponse>(updateMutation, updateVariables, 10))[updateResultKey] ?? { codeDiscountNode: null, userErrors: [] })
        : ((await destAdmin.graphql<DiscountCreateResponse>(createMutation, createVariables, 10))[createResultKey] ?? { codeDiscountNode: null, userErrors: [] });
      if (outcome.userErrors.length > 0 || !outcome.codeDiscountNode) {
        const message = joinUserErrors(outcome.userErrors, "Unknown discount mutation error");
        if (isDiscountSkippableError(message)) {
          await skipDiscountItem(job, item.id, message, existingId ?? null);
          continue;
        }
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      const destinationId = outcome.codeDiscountNode.id;
      await saveMapping({ storeConnectionId: job.storeConnectionId, resourceType: "discount", sourceId: item.sourceId, destinationId });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDiscountSkippableError(message)) {
        await skipDiscountItem(job, item.id, message, null);
        continue;
      }
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
    }
  }
}
