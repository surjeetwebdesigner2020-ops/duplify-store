import db from "../../../db.server";
import type { ProductSetVariantInput } from "../../shopify/mutations/products";
import { saveMapping } from "../idMapping.service";
import type { ProductBulkPayload } from "../types";

// productSet creates a product and all of its variants in one atomic call
// (see mutations/products.ts for why), so there is no separate "create a
// variant" API step to run as its own migration stage. This module instead
// owns the variant-specific pieces of that flow: shaping the input Shopify
// expects, and — once productSet succeeds — recording each variant as its
// own MigrationItem/IdMapping so it shows up individually in the dashboard,
// error logs, and ID mapping browser exactly like every other resource type.

export function buildVariantInputs(
  payload: ProductBulkPayload,
): ProductSetVariantInput[] {
  return payload.variants.map((variant) => ({
    optionValues: variant.selectedOptions.map((option) => ({
      optionName: option.name,
      name: option.value,
    })),
    price: variant.price,
    compareAtPrice: variant.compareAtPrice ?? undefined,
    sku: variant.sku ?? undefined,
    barcode: variant.barcode ?? undefined,
    taxable: variant.taxable,
    inventoryPolicy: variant.inventoryPolicy === "CONTINUE" ? "CONTINUE" : "DENY",
  }));
}

interface CreatedVariant {
  id: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

function optionsKey(options: Array<{ name: string; value: string }>): string {
  return options
    .map((o) => `${o.name}:${o.value}`)
    .sort()
    .join("|");
}

// Shopify doesn't echo back "this is the variant that came from input index 2"
// — match returned variants to source variants by SKU first (most reliable,
// since SKUs are usually unique), falling back to option-value combination.
export async function recordVariantMigrationItems(params: {
  migrationJobId: string;
  storeConnectionId: string;
  productSourceId: string;
  sourceVariants: ProductBulkPayload["variants"];
  createdVariants: CreatedVariant[];
}): Promise<void> {
  const bySku = new Map(
    params.createdVariants
      .filter((v) => v.sku)
      .map((v) => [v.sku as string, v]),
  );
  const byOptions = new Map(
    params.createdVariants.map((v) => [optionsKey(v.selectedOptions), v]),
  );

  for (const sourceVariant of params.sourceVariants) {
    const match =
      (sourceVariant.sku && bySku.get(sourceVariant.sku)) ||
      byOptions.get(optionsKey(sourceVariant.selectedOptions));

    await db.migrationItem.create({
      data: {
        migrationJobId: params.migrationJobId,
        resourceType: "variant",
        stage: "products",
        sourceId: sourceVariant.id,
        destinationId: match?.id ?? null,
        status: match ? "COMPLETED" : "FAILED",
        errorMessage: match
          ? null
          : "Could not match this variant in the productSet response (no SKU or option-value match)",
        payload: sourceVariant as unknown as object,
      },
    });

    if (match) {
      await saveMapping({
        storeConnectionId: params.storeConnectionId,
        resourceType: "variant",
        sourceId: sourceVariant.id,
        destinationId: match.id,
      });
    }
  }
}

export async function recordFailedVariantItems(params: {
  migrationJobId: string;
  productSourceId: string;
  sourceVariants: ProductBulkPayload["variants"];
  errorMessage: string;
}): Promise<void> {
  await db.migrationItem.createMany({
    data: params.sourceVariants.map((variant) => ({
      migrationJobId: params.migrationJobId,
      resourceType: "variant",
      stage: "products",
      sourceId: variant.id,
      status: "FAILED" as const,
      errorMessage: params.errorMessage,
      payload: variant as unknown as object,
    })),
  });
}
