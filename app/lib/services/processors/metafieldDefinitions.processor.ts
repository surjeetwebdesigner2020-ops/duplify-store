import db from "../../../db.server";
import { createAdminClient, type AdminClient } from "../../shopify/admin-client";
import {
  METAFIELD_DEFINITIONS_QUERY,
  METAFIELD_DEFINITION_LOOKUP_QUERY,
  METAFIELD_DEFINITION_OWNER_TYPES,
} from "../../shopify/queries/metafields";
import { METAFIELD_DEFINITION_CREATE_MUTATION, type MetafieldDefinitionInput } from "../../shopify/mutations/metafields";
import { getLiveMapping, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { MetafieldDefinitionBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import {
  isAppOwnedMetafieldNamespace,
  isDefinitionInUseError,
  shouldResolveExistingDefinition,
  shouldSkipDefinitionCreateError,
  skippedDefinitionMessage,
} from "./shopify-error-classifier";
import { joinUserErrors } from "../../shopify/graphql-safe";

function definitionSourceId(payload: MetafieldDefinitionBulkPayload): string {
  return `${payload.ownerType}:${payload.namespace}:${payload.key}`;
}

interface DefinitionsResponse {
  metafieldDefinitions: {
    edges: Array<{
      node: {
        id?: string;
        namespace: string;
        key: string;
        name: string;
        description: string | null;
        type: { name: string };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface DefinitionLookupResponse {
  metafieldDefinitions: {
    edges: Array<{ node: { id: string; namespace: string; key: string } }>;
  };
}

async function findDestMetafieldDefinitionId(
  destAdmin: AdminClient,
  def: MetafieldDefinitionBulkPayload,
): Promise<string | null> {
  try {
    const keyed = await destAdmin.graphql<DefinitionLookupResponse>(
      METAFIELD_DEFINITION_LOOKUP_QUERY,
      { ownerType: def.ownerType, namespace: def.namespace, key: def.key },
      5,
    );
    const keyedId = keyed.metafieldDefinitions?.edges?.[0]?.node?.id;
    if (keyedId) return keyedId;
  } catch {
    // Fall through to paginated scan.
  }

  // Fallback: page ownerType definitions and match namespace+key locally
  // (keyed filter can miss on some API/edge cases).
  try {
    let after: string | null = null;
    do {
      const page: DefinitionsResponse = await destAdmin.graphql<DefinitionsResponse>(
        METAFIELD_DEFINITIONS_QUERY,
        { ownerType: def.ownerType, after },
        10,
      );
      const match = page.metafieldDefinitions?.edges?.find(
        (e: DefinitionsResponse["metafieldDefinitions"]["edges"][number]) =>
          e.node.namespace === def.namespace && e.node.key === def.key,
      );
      if (match?.node.id) return match.node.id;
      after = page.metafieldDefinitions?.pageInfo?.hasNextPage
        ? page.metafieldDefinitions.pageInfo.endCursor
        : null;
    } while (after);
  } catch {
    return null;
  }
  return null;
}

async function completeWithExistingDefinition(
  job: MigrationJobWithConnection,
  itemId: string,
  sourceId: string,
  destinationId: string,
): Promise<void> {
  await saveMapping({
    storeConnectionId: job.storeConnectionId,
    resourceType: "metafield_definition",
    sourceId,
    destinationId,
  });
  await db.migrationItem.update({
    where: { id: itemId },
    data: { status: "COMPLETED", destinationId, errorMessage: null },
  });
}

/** Dest already has this def (Shopify said so) — mark done even if GID lookup failed. */
async function completeWithoutDestinationId(
  job: MigrationJobWithConnection,
  itemId: string,
): Promise<void> {
  await db.migrationItem.update({
    where: { id: itemId },
    data: {
      status: "COMPLETED",
      errorMessage: null,
    },
  });
  await logEvent(
    job.id,
    "INFO",
    "Metafield definition already on destination — marked complete",
    { itemId },
  );
}

export async function ensureMetafieldDefinitionItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "metafield_definition" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting metafield definitions from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);

  const rows: Array<{ migrationJobId: string; resourceType: string; stage: string; sourceId: string; status: "PENDING"; payload: object }> = [];
  let skippedAppOwned = 0;

  for (const ownerType of METAFIELD_DEFINITION_OWNER_TYPES) {
    let after: string | null = null;
    do {
      const result: DefinitionsResponse = await sourceAdmin.graphql<DefinitionsResponse>(
        METAFIELD_DEFINITIONS_QUERY,
        { ownerType, after },
        15,
      );
      for (const edge of result.metafieldDefinitions?.edges ?? []) {
        if (isAppOwnedMetafieldNamespace(edge.node.namespace)) {
          skippedAppOwned += 1;
          continue;
        }
        const payload: MetafieldDefinitionBulkPayload = {
          ownerType,
          namespace: edge.node.namespace,
          key: edge.node.key,
          name: edge.node.name,
          description: edge.node.description,
          type: edge.node.type.name,
        };
        rows.push({
          migrationJobId: job.id,
          resourceType: "metafield_definition",
          stage: "metafield_definitions",
          sourceId: definitionSourceId(payload),
          status: "PENDING",
          payload: payload as unknown as object,
        });
      }
      after = result.metafieldDefinitions?.pageInfo?.hasNextPage
        ? result.metafieldDefinitions.pageInfo.endCursor
        : null;
    } while (after);
  }

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(
    job.id,
    "INFO",
    `Found ${rows.length} metafield definitions to migrate` +
      (skippedAppOwned > 0 ? ` (excluded ${skippedAppOwned} app-owned)` : ""),
  );
}

interface DefinitionCreateResponse {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string } | null;
    userErrors: Array<{ field: string[]; message: string }> | null;
  } | null;
}

export async function runMetafieldDefinitionsStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureMetafieldDefinitionItems(job);

  const destAdmin = createAdminClient(job.storeConnection.destinationShop);
  const pendingItems = await db.migrationItem.findMany({
    // Include SKIPPED so re-runs can remap "already exists" defs to COMPLETED.
    where: { migrationJobId: job.id, resourceType: "metafield_definition", status: { in: ["PENDING", "RETRYING", "SKIPPED"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const def = item.payload as unknown as MetafieldDefinitionBulkPayload;
    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    if (isAppOwnedMetafieldNamespace(def.namespace)) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: {
          status: "SKIPPED",
          errorMessage: "App-owned metafield definition cannot be recreated by Duplify",
        },
      });
      continue;
    }

    const alreadyMapped = await getLiveMapping(destAdmin, job.storeConnectionId, "metafield_definition", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null } });
      continue;
    }

    // Idempotent: if dest already has this namespace/key, map and complete.
    const existingBeforeCreate = await findDestMetafieldDefinitionId(destAdmin, def);
    if (existingBeforeCreate) {
      await completeWithExistingDefinition(job, item.id, item.sourceId, existingBeforeCreate);
      continue;
    }

    const input: MetafieldDefinitionInput = {
      name: def.name,
      namespace: def.namespace,
      key: def.key,
      description: def.description ?? undefined,
      type: def.type,
      ownerType: def.ownerType,
    };

    try {
      const result = await destAdmin.graphql<DefinitionCreateResponse>(METAFIELD_DEFINITION_CREATE_MUTATION, { definition: input }, 10);
      const userErrors = result.metafieldDefinitionCreate?.userErrors ?? [];
      const resolveError = userErrors.find((e) => shouldResolveExistingDefinition(e.message));
      if (resolveError) {
        const existingId = await findDestMetafieldDefinitionId(destAdmin, def);
        if (existingId) {
          await completeWithExistingDefinition(job, item.id, item.sourceId, existingId);
          continue;
        }
        // "Already exists" without readable GID is still a success for migration UX.
        if (isDefinitionInUseError(resolveError.message)) {
          await completeWithoutDestinationId(job, item.id);
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

      if (userErrors.length > 0 || !result.metafieldDefinitionCreate?.createdDefinition) {
        const message = joinUserErrors(userErrors, "Unknown metafieldDefinitionCreate error");
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }

      const destinationId = result.metafieldDefinitionCreate.createdDefinition.id;
      await completeWithExistingDefinition(job, item.id, item.sourceId, destinationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldResolveExistingDefinition(message)) {
        const existingId = await findDestMetafieldDefinitionId(destAdmin, def);
        if (existingId) {
          await completeWithExistingDefinition(job, item.id, item.sourceId, existingId);
          continue;
        }
        if (isDefinitionInUseError(message)) {
          await completeWithoutDestinationId(job, item.id);
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
