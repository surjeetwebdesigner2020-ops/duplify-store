import db from "../../../db.server";
import { createAdminClient, type AdminClient } from "../../shopify/admin-client";
import {
  METAOBJECT_DEFINITION_BY_TYPE_QUERY,
  METAOBJECT_DEFINITIONS_QUERY,
  METAOBJECTS_BY_TYPE_QUERY,
} from "../../shopify/queries/metaobjects";
import {
  METAOBJECT_CREATE_MUTATION,
  METAOBJECT_DEFINITION_CREATE_MUTATION,
  type MetaobjectCreateInput,
  type MetaobjectDefinitionCreateInput,
} from "../../shopify/mutations/metaobjects";
import { getLiveMapping, getMappingBySourceIdAnyType, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { MetaobjectDefinitionBulkPayload, MetaobjectEntryBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import {
  isAppOwnedMetaobjectType,
  isDefinitionInUseError,
  shouldResolveExistingDefinition,
  shouldSkipDefinitionCreateError,
  skippedDefinitionMessage,
} from "./shopify-error-classifier";
import { joinUserErrors } from "../../shopify/graphql-safe";

// --- Definitions -----------------------------------------------------------

interface DefinitionsResponse {
  metaobjectDefinitions: {
    edges: Array<{
      node: {
        id?: string;
        type: string;
        name: string;
        fieldDefinitions: Array<{ key: string; name: string; required: boolean; type: { name: string } }>;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface DefinitionByTypeResponse {
  metaobjectDefinitionByType: { id: string; type: string } | null;
}

async function findDestMetaobjectDefinitionId(
  destAdmin: AdminClient,
  type: string,
): Promise<string | null> {
  try {
    const result = await destAdmin.graphql<DefinitionByTypeResponse>(
      METAOBJECT_DEFINITION_BY_TYPE_QUERY,
      { type },
      5,
    );
    if (result.metaobjectDefinitionByType?.id) return result.metaobjectDefinitionByType.id;
  } catch {
    // Fall through to list scan.
  }

  try {
    let after: string | null = null;
    do {
      const page: DefinitionsResponse = await destAdmin.graphql<DefinitionsResponse>(
        METAOBJECT_DEFINITIONS_QUERY,
        { after },
        10,
      );
      const match = page.metaobjectDefinitions?.edges?.find(
        (e: DefinitionsResponse["metaobjectDefinitions"]["edges"][number]) => e.node.type === type,
      );
      if (match?.node.id) return match.node.id;
      after = page.metaobjectDefinitions?.pageInfo?.hasNextPage
        ? page.metaobjectDefinitions.pageInfo.endCursor
        : null;
    } while (after);
  } catch {
    return null;
  }
  return null;
}

async function completeWithExistingMetaobjectDefinition(
  job: MigrationJobWithConnection,
  itemId: string,
  sourceId: string,
  destinationId: string,
): Promise<void> {
  await saveMapping({
    storeConnectionId: job.storeConnectionId,
    resourceType: "metaobject_definition",
    sourceId,
    destinationId,
  });
  await db.migrationItem.update({
    where: { id: itemId },
    data: { status: "COMPLETED", destinationId, errorMessage: null },
  });
}

async function completeMetaobjectDefinitionWithoutId(
  job: MigrationJobWithConnection,
  itemId: string,
): Promise<void> {
  await db.migrationItem.update({
    where: { id: itemId },
    data: { status: "COMPLETED", errorMessage: null },
  });
  await logEvent(
    job.id,
    "INFO",
    "Metaobject definition already on destination — marked complete",
    { itemId },
  );
}

export async function ensureMetaobjectDefinitionItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "metaobject_definition" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting metaobject definitions from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);

  const rows: Array<{ migrationJobId: string; resourceType: string; stage: string; sourceId: string; status: "PENDING"; payload: object }> = [];
  let skippedAppOwned = 0;
  let after: string | null = null;
  do {
    const result: DefinitionsResponse = await sourceAdmin.graphql<DefinitionsResponse>(METAOBJECT_DEFINITIONS_QUERY, { after }, 15);
    for (const edge of result.metaobjectDefinitions?.edges ?? []) {
      if (isAppOwnedMetaobjectType(edge.node.type)) {
        skippedAppOwned += 1;
        continue;
      }
      const payload: MetaobjectDefinitionBulkPayload = {
        type: edge.node.type,
        name: edge.node.name,
        fieldDefinitions: (edge.node.fieldDefinitions ?? []).map((f) => ({
          key: f.key,
          name: f.name,
          type: f.type.name,
          required: f.required,
        })),
      };
      rows.push({
        migrationJobId: job.id,
        resourceType: "metaobject_definition",
        stage: "metaobject_definitions",
        sourceId: edge.node.type,
        status: "PENDING",
        payload: payload as unknown as object,
      });
    }
    after = result.metaobjectDefinitions?.pageInfo?.hasNextPage
      ? result.metaobjectDefinitions.pageInfo.endCursor
      : null;
  } while (after);

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(
    job.id,
    "INFO",
    `Found ${rows.length} metaobject definitions to migrate` +
      (skippedAppOwned > 0 ? ` (excluded ${skippedAppOwned} app-owned)` : ""),
  );
}

interface DefinitionCreateResponse {
  metaobjectDefinitionCreate: {
    metaobjectDefinition: { id: string; type: string } | null;
    userErrors: Array<{ field: string[]; message: string }> | null;
  } | null;
}

export async function runMetaobjectDefinitionsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureMetaobjectDefinitionItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    // Include SKIPPED so re-runs can remap "already exists" defs to COMPLETED.
    where: { migrationJobId: job.id, resourceType: "metaobject_definition", status: { in: ["PENDING", "RETRYING", "SKIPPED"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const def = item.payload as unknown as MetaobjectDefinitionBulkPayload;
    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    if (isAppOwnedMetaobjectType(def.type)) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: {
          status: "SKIPPED",
          errorMessage: "App-owned metaobject definition cannot be recreated by Duplify",
        },
      });
      continue;
    }

    const alreadyMapped = await getLiveMapping(destAdmin, job.storeConnectionId, "metaobject_definition", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null } });
      continue;
    }

    const existingBeforeCreate = await findDestMetaobjectDefinitionId(destAdmin, def.type);
    if (existingBeforeCreate) {
      await completeWithExistingMetaobjectDefinition(job, item.id, item.sourceId, existingBeforeCreate);
      continue;
    }

    const input: MetaobjectDefinitionCreateInput = {
      type: def.type,
      name: def.name,
      fieldDefinitions: (def.fieldDefinitions ?? []).map((f) => ({
        key: f.key,
        name: f.name,
        type: f.type,
        required: f.required,
      })),
    };

    try {
      const result = await destAdmin.graphql<DefinitionCreateResponse>(METAOBJECT_DEFINITION_CREATE_MUTATION, { definition: input }, 10);
      const userErrors = result.metaobjectDefinitionCreate?.userErrors ?? [];
      const resolveError = userErrors.find((e) => shouldResolveExistingDefinition(e.message));
      if (resolveError) {
        const existingId = await findDestMetaobjectDefinitionId(destAdmin, def.type);
        if (existingId) {
          await completeWithExistingMetaobjectDefinition(job, item.id, item.sourceId, existingId);
          continue;
        }
        if (isDefinitionInUseError(resolveError.message)) {
          await completeMetaobjectDefinitionWithoutId(job, item.id);
          continue;
        }
      }

      const skippableError = userErrors.find((e) => shouldSkipDefinitionCreateError(e.message));
      if (skippableError) {
        await db.migrationItem.update({
          where: { id: item.id },
          data: { status: "SKIPPED", errorMessage: skippedDefinitionMessage(skippableError.message) },
        });
        continue;
      }
      if (userErrors.length > 0 || !result.metaobjectDefinitionCreate?.metaobjectDefinition) {
        const message = joinUserErrors(userErrors, "Unknown metaobjectDefinitionCreate error");
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }

      const destinationId = result.metaobjectDefinitionCreate.metaobjectDefinition.id;
      await completeWithExistingMetaobjectDefinition(job, item.id, item.sourceId, destinationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldResolveExistingDefinition(message)) {
        const existingId = await findDestMetaobjectDefinitionId(destAdmin, def.type);
        if (existingId) {
          await completeWithExistingMetaobjectDefinition(job, item.id, item.sourceId, existingId);
          continue;
        }
        if (isDefinitionInUseError(message)) {
          await completeMetaobjectDefinitionWithoutId(job, item.id);
          continue;
        }
      }
      if (shouldSkipDefinitionCreateError(message)) {
        await db.migrationItem.update({
          where: { id: item.id },
          data: {
            status: "SKIPPED",
            errorMessage: skippedDefinitionMessage(message),
          },
        });
        continue;
      }
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
      await logEvent(job.id, "ERROR", message, { itemId: item.id });
    }
  }
}

// --- Entries -----------------------------------------------------------

interface EntriesResponse {
  metaobjects: {
    edges: Array<{ node: { id: string; handle: string; fields: Array<{ key: string; value: string; type: string }> } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function ensureMetaobjectEntryItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "metaobject" } });
  if (existing > 0) return;

  // Only definitions that landed (or already existed) on dest — skip app-owned skips.
  const definitionItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "metaobject_definition", status: "COMPLETED" },
  });
  if (definitionItems.length === 0) return;

  await logEvent(job.id, "INFO", "Exporting metaobject entries from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);

  const rows: Array<{ migrationJobId: string; resourceType: string; stage: string; sourceId: string; status: "PENDING"; payload: object }> = [];

  for (const defItem of definitionItems) {
    const type = defItem.sourceId;
    let after: string | null = null;
    do {
      const result: EntriesResponse = await sourceAdmin.graphql<EntriesResponse>(METAOBJECTS_BY_TYPE_QUERY, { type, after }, 15);
      for (const edge of result.metaobjects.edges) {
        const payload: MetaobjectEntryBulkPayload = {
          id: edge.node.id,
          definitionType: type,
          handle: edge.node.handle,
          fields: edge.node.fields,
        };
        rows.push({
          migrationJobId: job.id,
          resourceType: "metaobject",
          stage: "metaobjects",
          sourceId: payload.id,
          status: "PENDING",
          payload: payload as unknown as object,
        });
      }
      after = result.metaobjects.pageInfo.hasNextPage ? result.metaobjects.pageInfo.endCursor : null;
    } while (after);
  }

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} metaobject entries to migrate`);
}

interface MetaobjectCreateResponse {
  metaobjectCreate: { metaobject: { id: string; handle: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}

export async function runMetaobjectsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureMetaobjectEntryItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "metaobject", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const entry = item.payload as unknown as MetaobjectEntryBulkPayload;
    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    const alreadyMapped = await getLiveMapping(destAdmin, job.storeConnectionId, "metaobject", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null } });
      continue;
    }

    // Best-effort remap of reference-type field values (a GID pointing at
    // another resource) to their destination-store equivalents; falls back to
    // the original value if no mapping is found yet (e.g. forward reference).
    const fields: Array<{ key: string; value: string }> = [];
    for (const field of entry.fields) {
      if (field.type.includes("reference") && field.value.startsWith("gid://shopify/")) {
        const remapped = await getMappingBySourceIdAnyType(job.storeConnectionId, field.value);
        fields.push({ key: field.key, value: remapped ?? field.value });
      } else {
        fields.push({ key: field.key, value: field.value });
      }
    }

    const input: MetaobjectCreateInput = { type: entry.definitionType, handle: entry.handle, fields };

    try {
      const result = await destAdmin.graphql<MetaobjectCreateResponse>(METAOBJECT_CREATE_MUTATION, { metaobject: input }, 10);
      if (result.metaobjectCreate.userErrors.length > 0 || !result.metaobjectCreate.metaobject) {
        const message = joinUserErrors(result.metaobjectCreate?.userErrors, "Unknown metaobjectCreate error");
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      const destinationId = result.metaobjectCreate.metaobject.id;
      await saveMapping({ storeConnectionId: job.storeConnectionId, resourceType: "metaobject", sourceId: item.sourceId, destinationId });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
      await logEvent(job.id, "ERROR", message, { itemId: item.id });
    }
  }
}
