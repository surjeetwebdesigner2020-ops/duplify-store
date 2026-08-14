import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { collectGroupedBulkResults, runBulkQuery } from "../../shopify/bulk-operations";
import { joinUserErrors } from "../../shopify/graphql-safe";
import { BULK_FILES_QUERY } from "../../shopify/queries/files";
import { FILE_CREATE_MUTATION, type FileCreateInput } from "../../shopify/mutations/files";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { FileBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { isInvalidRemoteFileError } from "./shopify-error-classifier";

function contentTypeFromGid(id: string): FileBulkPayload["contentType"] {
  if (id.includes("/MediaImage/")) return "IMAGE";
  if (id.includes("/Video/")) return "VIDEO";
  return "FILE";
}

export async function ensureFileItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "file" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting files from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const op = await runBulkQuery(sourceAdmin, BULK_FILES_QUERY);
  if (!op.url) {
    await logEvent(job.id, "INFO", "Source store has no files to migrate");
    return;
  }

  const grouped = await collectGroupedBulkResults(op.url);
  const rows = grouped
    .map((record) => {
      const node = record.parent as Record<string, unknown>;
      const id = node.id as string;
      const url = (node.url as string | undefined) ?? (node.image as { url?: string } | undefined)?.url ??
        ((node.sources as Array<{ url: string }> | undefined)?.[0]?.url);
      if (!url) return null;

      const payload: FileBulkPayload = {
        id,
        alt: (node.alt as string | null) ?? null,
        url,
        contentType: contentTypeFromGid(id),
      };

      return {
        migrationJobId: job.id,
        resourceType: "file",
        stage: "files",
        sourceId: id,
        status: "PENDING" as const,
        payload: payload as unknown as object,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} files to migrate`);
}

interface FileCreateResponse {
  fileCreate: {
    files: Array<{ id: string }>;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

export async function runFilesStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureFileItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "file", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const file = item.payload as unknown as FileBulkPayload;
    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    // A prior run may have uploaded this file before its migration item was
    // marked complete. Reuse the connection-scoped mapping to avoid a duplicate.
    const alreadyMapped = await getLiveMapping(destAdmin, job.storeConnectionId, "file", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null },
      });
      continue;
    }

    const input: FileCreateInput = { originalSource: file.url!, alt: file.alt ?? undefined, contentType: file.contentType };

    try {
      const result = await destAdmin.graphql<FileCreateResponse>(FILE_CREATE_MUTATION, { files: [input] }, 15);
      const fileCreate = result.fileCreate;
      if (
        !fileCreate ||
        (fileCreate.userErrors?.length ?? 0) > 0 ||
        !(fileCreate.files?.length)
      ) {
        const message = joinUserErrors(
          fileCreate?.userErrors,
          "Unknown fileCreate error",
        );
        if (isInvalidRemoteFileError(message)) {
          await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", errorMessage: message } });
          await logEvent(job.id, "WARN", `Skipped file with unsupported source URL: ${message}`, { itemId: item.id });
          continue;
        }
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      const destinationId = fileCreate.files[0].id;
      await saveMapping({ storeConnectionId: job.storeConnectionId, resourceType: "file", sourceId: item.sourceId, destinationId });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isInvalidRemoteFileError(message)) {
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", errorMessage: message } });
        await logEvent(job.id, "WARN", `Skipped file with unsupported source URL: ${message}`, { itemId: item.id });
        continue;
      }
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
      await logEvent(job.id, "ERROR", message, { itemId: item.id });
    }
  }
}
