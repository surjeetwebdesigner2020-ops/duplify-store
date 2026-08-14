import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { PRODUCT_CREATE_MEDIA_MUTATION } from "../../shopify/mutations/products";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ProductBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { isInvalidRemoteFileError } from "./shopify-error-classifier";
import { joinUserErrors } from "../../shopify/graphql-safe";

// Runs after Products: attaches each source product's images to the matching
// destination product via productCreateMedia, which lets Shopify fetch and
// re-host the image from its original (source-store) URL asynchronously.
// Each image is its own MigrationItem so a single broken image URL can't
// block — or hide the status of — the rest of a product's photos.

export async function ensureImageItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({
    where: { migrationJobId: job.id, resourceType: "image" },
  });
  if (existing > 0) return;

  const completedProducts = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "product",
      status: { in: ["COMPLETED", "SKIPPED"] },
      destinationId: { not: null },
    },
  });

  const rows = completedProducts.flatMap((productItem) => {
    const payload = productItem.payload as unknown as ProductBulkPayload;
    return payload.media
      .filter((m) => m.image?.url)
      .map((media) => ({
        migrationJobId: job.id,
        resourceType: "image",
        stage: "images",
        sourceId: media.id,
        status: "PENDING" as const,
        payload: {
          url: media.image!.url,
          alt: media.alt,
          productSourceId: productItem.sourceId,
        } as unknown as object,
      }));
  });

  if (rows.length > 0) {
    await db.migrationItem.createMany({ data: rows });
  }
  await logEvent(job.id, "INFO", `Found ${rows.length} product image(s) to migrate`);
}

interface ProductCreateMediaResponse {
  productCreateMedia: {
    media: Array<{ id: string; status: string }>;
    mediaUserErrors: Array<{ field: string[]; message: string }>;
  };
}

export async function runImagesStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureImageItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "image",
      status: { in: ["PENDING", "RETRYING"] },
    },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const payload = item.payload as { url: string; alt: string | null; productSourceId: string };

    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "PROCESSING", attempt: item.attempt + 1 },
    });

    const productMapping = await getLiveMapping(
      destAdmin,
      job.storeConnectionId,
      "product",
      payload.productSourceId,
    );
    if (!productMapping) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "SKIPPED", errorMessage: "Parent product was not migrated (skipped or failed)" },
      });
      continue;
    }

    try {
      const result = await destAdmin.graphql<ProductCreateMediaResponse>(
        PRODUCT_CREATE_MEDIA_MUTATION,
        {
          productId: productMapping.destinationId,
          media: [{ originalSource: payload.url, alt: payload.alt ?? "", mediaContentType: "IMAGE" }],
        },
        20,
      );

      if (result.productCreateMedia.mediaUserErrors.length > 0) {
        const message = joinUserErrors(result.productCreateMedia?.mediaUserErrors, "Unknown productCreateMedia error");
        if (isInvalidRemoteFileError(message)) {
          await db.migrationItem.update({
            where: { id: item.id },
            data: { status: "SKIPPED", errorMessage: message },
          });
          await logEvent(job.id, "WARN", `Skipped product image with unsupported source URL: ${message}`);
          continue;
        }
        await db.migrationItem.update({
          where: { id: item.id },
          data: { status: "FAILED", errorMessage: message },
        });
        await logEvent(job.id, "ERROR", `Image failed for product ${payload.productSourceId}: ${message}`);
        continue;
      }

      const media = result.productCreateMedia.media[0];
      await saveMapping({
        storeConnectionId: job.storeConnectionId,
        resourceType: "image",
        sourceId: item.sourceId,
        destinationId: media.id,
      });
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "COMPLETED", destinationId: media.id, errorMessage: null },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isInvalidRemoteFileError(message)) {
        await db.migrationItem.update({
          where: { id: item.id },
          data: { status: "SKIPPED", errorMessage: message },
        });
        await logEvent(job.id, "WARN", `Skipped product image with unsupported source URL: ${message}`);
        continue;
      }
      await db.migrationItem.update({
        where: { id: item.id },
        data: {
          status: "FAILED",
          errorMessage: message,
        },
      });
    }
  }
}
