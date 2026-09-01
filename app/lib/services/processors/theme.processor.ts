import db from "../../../db.server";
import { createAdminClient, type AdminClient } from "../../shopify/admin-client";
import {
  MAIN_THEME_QUERY,
  THEMES_BY_NAME_QUERY,
  THEME_FILES_BY_ID_QUERY,
} from "../../shopify/queries/theme";
import {
  THEME_CREATE_BASE_ZIP_URL,
  THEME_CREATE_MUTATION,
  THEME_FILES_DELETE_MUTATION,
  THEME_FILES_UPSERT_MUTATION,
  THEME_PROCESSING_QUERY,
  type ThemeFileUpsertInput,
} from "../../shopify/mutations/theme";
import { joinUserErrors } from "../../shopify/graphql-safe";
import { saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ThemeFileBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";

// Shopify has no cross-store "clone theme" API. We:
// 1) export source theme files
// 2) find or create an unpublished destination theme with the same name
// 3) upsert source files, then delete leftover scaffold files
//
// Paid/marketplace themes may have license restrictions — surfaced in the UI.

interface ThemeFilesNode {
  id: string;
  name: string;
  files?: {
    edges?: Array<{
      node: {
        filename: string;
        body: { content?: string; contentBase64?: string; url?: string } | null;
      };
    }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  } | null;
}
interface MainThemeResponse {
  themes?: { edges?: Array<{ node: ThemeFilesNode }> };
}
interface ThemeByIdResponse {
  node: ThemeFilesNode | null;
}

function normalizeThemeSourceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("gid://shopify/")) {
    return undefined;
  }
  return trimmed;
}

export async function ensureThemeItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({
    where: { migrationJobId: job.id, resourceType: "theme" },
  });
  if (existing > 0) return;

  await logEvent(
    job.id,
    "INFO",
    "Theme migration will copy source theme files onto an unpublished destination theme (auto-created if needed)",
  );

  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);
  const chosenThemeId = normalizeThemeSourceId(
    (job.conflictStrategy as Record<string, unknown>)
      .__themeSourceId as string | undefined,
  );
  if (chosenThemeId !== undefined) {
    await logEvent(
      job.id,
      "INFO",
      `Using selected source theme ${chosenThemeId} for theme export`,
    );
  }

  let after: string | null = null;
  let themeId: string | null = null;
  let themeName = "";
  const files: ThemeFileBulkPayload[] = [];

  do {
    let theme: ThemeFilesNode | undefined;
    if (chosenThemeId) {
      const result: ThemeByIdResponse = await sourceAdmin.graphql<ThemeByIdResponse>(
        THEME_FILES_BY_ID_QUERY,
        { id: chosenThemeId, after },
        20,
      );
      theme = result.node ?? undefined;
    } else {
      const result: MainThemeResponse = await sourceAdmin.graphql<MainThemeResponse>(
        MAIN_THEME_QUERY,
        { after },
        20,
      );
      theme = result.themes?.edges?.[0]?.node;
    }

    if (!theme) {
      await logEvent(
        job.id,
        "WARN",
        "Selected source theme is no longer available; falling back to the live theme for export",
      );
      if (chosenThemeId) {
        // The source theme may have been deleted or the ID may be stale. Keep the
        // migration moving by exporting the live theme instead of failing the stage.
        return await ensureThemeItems({
          ...job,
          conflictStrategy: {
            ...((job.conflictStrategy as Record<string, unknown>) ?? {}),
            __themeSourceId: undefined,
          },
        });
      }
      return;
    }
    themeId = theme.id;
    themeName = theme.name;
    for (const edge of theme.files?.edges ?? []) {
      const body = toThemeFilePayload(edge.node.filename, edge.node.body);
      if (body) {
        files.push(body);
      }
    }
    after = theme.files?.pageInfo?.hasNextPage
      ? theme.files.pageInfo.endCursor
      : null;
  } while (after);

  if (files.length === 0) {
    await logEvent(
      job.id,
      "WARN",
      `Source theme "${themeName}" exported 0 readable files — check read_themes access on the source store`,
    );
    return;
  }

  await db.migrationItem.create({
    data: {
      migrationJobId: job.id,
      resourceType: "theme",
      stage: "theme",
      sourceId: themeId!,
      status: "PENDING",
      payload: { themeName, files } as unknown as object,
    },
  });
  await logEvent(
    job.id,
    "INFO",
    `Found theme "${themeName}" with ${files.length} files to migrate`,
  );
}

interface ThemesByNameResponse {
  themes?: {
    edges?: Array<{ node: { id: string; name: string; role: string } }>;
  };
}
interface ThemeFilesUpsertResponse {
  themeFilesUpsert: {
    upsertedThemeFiles: Array<{ filename: string }>;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}
interface ThemeCreateResponse {
  themeCreate: {
    theme: { id: string; name: string; role: string; processing: boolean } | null;
    userErrors: Array<{ field: string[]; message: string; code?: string }>;
  };
}
interface ThemeProcessingResponse {
  theme: { id: string; processing: boolean } | null;
}
interface ThemeFilesDeleteResponse {
  themeFilesDelete: {
    deletedThemeFiles: Array<{ filename: string }> | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

const BATCH_SIZE = 20;

export async function runThemeStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureThemeItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    where: {
      migrationJobId: job.id,
      resourceType: "theme",
      status: { in: ["PENDING", "RETRYING"] },
    },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const { themeName, files } = item.payload as unknown as {
      themeName: string;
      files: ThemeFileBulkPayload[];
    };

    await db.migrationItem.update({
      where: { id: item.id },
      data: { status: "PROCESSING", attempt: item.attempt + 1 },
    });

    let destinationThemeId: string | null = null;
    try {
      destinationThemeId = await resolveOrCreateDestinationTheme(
        destAdmin,
        themeName,
        job.id,
      );
    } catch (error) {
      await fail(job.id, item.id, errMsg(error));
      continue;
    }

    if (!destinationThemeId) {
      await fail(
        job.id,
        item.id,
        `Could not create destination theme "${themeName}". Check write_themes permission on the destination store.`,
      );
      continue;
    }

    let failedBatch = false;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (await isMigrationCancelled(job.id)) {
        await db.migrationItem.update({
          where: { id: item.id },
          data: { status: item.status, attempt: item.attempt },
        });
        return;
      }
      const batch = files.slice(i, i + BATCH_SIZE);
      const input: ThemeFileUpsertInput[] = batch.map((f) => ({
        filename: f.filename,
        body: { type: f.bodyType, value: f.value },
      }));

      try {
        const result = await destAdmin.graphql<ThemeFilesUpsertResponse>(
          THEME_FILES_UPSERT_MUTATION,
          { themeId: destinationThemeId, files: input },
          Math.ceil(batch.length / 2) + 5,
        );
        if ((result.themeFilesUpsert?.userErrors?.length ?? 0) > 0) {
          const message = joinUserErrors(
            result.themeFilesUpsert?.userErrors,
            "themeFilesUpsert failed",
          );
          await logEvent(
            job.id,
            "WARN",
            `Some theme files failed in batch ${i / BATCH_SIZE + 1}: ${message}`,
          );
          failedBatch = true;
        }
      } catch (error) {
        await logEvent(
          job.id,
          "ERROR",
          `Theme file batch ${i / BATCH_SIZE + 1} failed: ${errMsg(error)}`,
        );
        failedBatch = true;
      }
    }

    // Remove scaffold Dawn files that were not part of the source theme.
    try {
      await pruneScaffoldFiles(destAdmin, destinationThemeId, files, job.id);
    } catch (error) {
      await logEvent(
        job.id,
        "WARN",
        `Theme files copied but cleanup of scaffold files failed: ${errMsg(error)}`,
      );
    }

    await saveMapping({
      storeConnectionId: job.storeConnectionId,
      resourceType: "theme",
      sourceId: item.sourceId,
      destinationId: destinationThemeId,
    });
    await db.migrationItem.update({
      where: { id: item.id },
      data: {
        status: failedBatch ? "FAILED" : "COMPLETED",
        destinationId: destinationThemeId,
        errorMessage: failedBatch
          ? "Some theme files failed to upload — see logs"
          : null,
      },
    });
    await logEvent(
      job.id,
      "INFO",
      `Migrated theme "${themeName}" (${files.length} files) to unpublished theme on destination — publish it from Online Store > Themes when ready`,
      { sourceId: item.sourceId, destinationId: destinationThemeId },
    );
  }
}

async function resolveOrCreateDestinationTheme(
  destAdmin: AdminClient,
  themeName: string,
  migrationJobId: string,
): Promise<string | null> {
  const themesResult = await destAdmin.graphql<ThemesByNameResponse>(
    THEMES_BY_NAME_QUERY,
    undefined,
    10,
  );
  const themeEdges = themesResult.themes?.edges ?? [];
  const existing =
    themeEdges.find(
      (e) => e.node.name === themeName && e.node.role !== "MAIN",
    )?.node.id ??
    themeEdges.find(
      (e) =>
        e.node.name === `Duplify — ${themeName}` && e.node.role !== "MAIN",
    )?.node.id ??
    null;

  if (existing) {
    await logEvent(
      migrationJobId,
      "INFO",
      `Using existing unpublished destination theme for "${themeName}"`,
    );
    return existing;
  }

  const createName = themeName.slice(0, 50) || "Duplify theme copy";
  await logEvent(
    migrationJobId,
    "INFO",
    `Creating unpublished destination theme "${createName}"`,
  );

  const created = await destAdmin.graphql<ThemeCreateResponse>(
    THEME_CREATE_MUTATION,
    {
      name: createName,
      source: THEME_CREATE_BASE_ZIP_URL,
      role: "UNPUBLISHED",
    },
    20,
  );

  if (
    !created.themeCreate ||
    (created.themeCreate.userErrors?.length ?? 0) > 0 ||
    !created.themeCreate.theme
  ) {
    const message = joinUserErrors(
      created.themeCreate?.userErrors,
      "themeCreate failed",
    );
    throw new Error(message);
  }

  const themeId = created.themeCreate.theme.id;
  await waitForThemeReady(destAdmin, themeId);
  return themeId;
}

async function waitForThemeReady(
  destAdmin: AdminClient,
  themeId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await destAdmin.graphql<ThemeProcessingResponse>(
      THEME_PROCESSING_QUERY,
      { id: themeId },
      2,
    );
    if (result.theme && !result.theme.processing) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function pruneScaffoldFiles(
  destAdmin: AdminClient,
  themeId: string,
  sourceFiles: ThemeFileBulkPayload[],
  migrationJobId: string,
): Promise<void> {
  const sourceNames = new Set(sourceFiles.map((f) => f.filename));
  const destFiles: string[] = [];
  let after: string | null = null;

  do {
    const result: ThemeByIdResponse = await destAdmin.graphql<ThemeByIdResponse>(
      THEME_FILES_BY_ID_QUERY,
      { id: themeId, after },
      15,
    );
    const theme = result.node;
    if (!theme) break;
    for (const edge of theme.files?.edges ?? []) {
      destFiles.push(edge.node.filename);
    }
    after = theme.files?.pageInfo?.hasNextPage
      ? theme.files.pageInfo.endCursor
      : null;
  } while (after);

  const extras = destFiles.filter((name) => !sourceNames.has(name));
  if (extras.length === 0) return;

  for (let i = 0; i < extras.length; i += BATCH_SIZE) {
    const batch = extras.slice(i, i + BATCH_SIZE);
    const result = await destAdmin.graphql<ThemeFilesDeleteResponse>(
      THEME_FILES_DELETE_MUTATION,
      { themeId, files: batch },
      10,
    );
    if ((result.themeFilesDelete?.userErrors?.length ?? 0) > 0) {
      await logEvent(
        migrationJobId,
        "WARN",
        `Could not delete some scaffold theme files: ${joinUserErrors(
          result.themeFilesDelete?.userErrors,
        )}`,
      );
    }
  }
}

async function fail(
  migrationJobId: string,
  itemId: string,
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

function toThemeFilePayload(
  filename: string,
  body: { content?: string; contentBase64?: string; url?: string } | null,
): ThemeFileBulkPayload | null {
  if (!body) return null;
  if (body.content !== undefined) {
    return { filename, bodyType: "TEXT", value: body.content };
  }
  if (body.contentBase64 !== undefined) {
    return { filename, bodyType: "BASE64", value: body.contentBase64 };
  }
  if (body.url !== undefined) {
    return { filename, bodyType: "URL", value: body.url };
  }
  return null;
}
