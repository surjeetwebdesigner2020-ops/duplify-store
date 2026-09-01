import db from "../../../db.server";
import { createAdminClient } from "../../shopify/admin-client";
import { MENUS_QUERY, MENU_BY_HANDLE_QUERY } from "../../shopify/queries/menus";
import { MENU_CREATE_MUTATION, MENU_UPDATE_MUTATION, type MenuItemCreateInput } from "../../shopify/mutations/menus";
import { getLiveMapping, getMappingBySourceIdAnyType, saveMapping } from "../idMapping.service";
import { isMigrationCancelled, logEvent } from "../migrationJob.service";
import type { ConflictStrategy, MenuBulkPayload } from "../types";
import type { MigrationJobWithConnection } from "../orchestrator.service";
import { joinUserErrors } from "../../shopify/graphql-safe";

interface MenusResponse {
  menus: {
    edges: Array<{ node: { id: string; handle: string; title: string; items: Array<{ title: string; type: string; url: string | null; resourceId: string | null }> } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export async function ensureMenuItems(job: MigrationJobWithConnection): Promise<void> {
  const existing = await db.migrationItem.count({ where: { migrationJobId: job.id, resourceType: "menu" } });
  if (existing > 0) return;

  await logEvent(job.id, "INFO", "Exporting menus from source store");
  const sourceAdmin = createAdminClient(job.storeConnection.sourceShop);

  const rows: Array<{ migrationJobId: string; resourceType: string; stage: string; sourceId: string; status: "PENDING"; payload: object }> = [];
  let after: string | null = null;
  do {
    const result: MenusResponse = await sourceAdmin.graphql<MenusResponse>(MENUS_QUERY, { after }, 10);
    for (const edge of result.menus.edges) {
      const payload: MenuBulkPayload = {
        id: edge.node.id,
        handle: edge.node.handle,
        title: edge.node.title,
        items: edge.node.items.map((i) => ({ title: i.title, type: i.type, url: i.url, resourceSourceId: i.resourceId })),
      };
      rows.push({
        migrationJobId: job.id,
        resourceType: "menu",
        stage: "menus",
        sourceId: edge.node.id,
        status: "PENDING",
        payload: payload as unknown as object,
      });
    }
    after = result.menus.pageInfo.hasNextPage ? result.menus.pageInfo.endCursor : null;
  } while (after);

  if (rows.length > 0) await db.migrationItem.createMany({ data: rows });
  await logEvent(job.id, "INFO", `Found ${rows.length} menus to migrate`);
}

interface MenuCreateResponse {
  menuCreate: { menu: { id: string; handle: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}
interface MenuByHandleResponse {
  menus: { edges: Array<{ node: { id: string; handle: string } }> };
}
interface MenuMutationResponse {
  menuUpdate: { menu: { id: string; handle: string } | null; userErrors: Array<{ field: string[]; message: string }> };
}

export async function runMenusStage(job: MigrationJobWithConnection): Promise<void> {
  await ensureMenuItems(job);

  const conflictStrategy: ConflictStrategy =
    (job.conflictStrategy as Record<string, ConflictStrategy>).menus ?? "SKIP";
  const destAdmin = createAdminClient(job.storeConnection.destinationShop);

  const pendingItems = await db.migrationItem.findMany({
    where: { migrationJobId: job.id, resourceType: "menu", status: { in: ["PENDING", "RETRYING"] } },
  });

  for (const item of pendingItems) {
    if (await isMigrationCancelled(job.id)) return;
    const menu = item.payload as unknown as MenuBulkPayload;
    const storeConnectionId = job.storeConnectionId;

    await db.migrationItem.update({ where: { id: item.id }, data: { status: "PROCESSING", attempt: item.attempt + 1 } });

    const alreadyMapped = await getLiveMapping(destAdmin, storeConnectionId, "menu", item.sourceId);
    if (alreadyMapped) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: alreadyMapped.destinationId, errorMessage: null } });
      continue;
    }

    let existingMenu: { id: string; handle: string } | null = null;
    try {
      const existing = await destAdmin.graphql<MenuByHandleResponse>(MENU_BY_HANDLE_QUERY, undefined, 5);
      existingMenu = existing.menus.edges.find((edge) => edge.node.handle === menu.handle)?.node ?? null;
      if (existingMenu && conflictStrategy === "SKIP") {
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", errorMessage: "Menu with this handle already exists on the destination store" } });
        continue;
      }
    } catch (error) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: `Conflict check failed: ${errMsg(error)}` } });
      continue;
    }

    // Customer-account pages are generated per shop and their resource IDs
    // cannot be copied to another shop. Shopify creates/manages that menu on
    // the destination when customer accounts are enabled.
    const portableMenuItems = menu.items.filter(
      (menuItem) => menuItem.type !== "CUSTOMER_ACCOUNT_PAGE",
    );
    if (portableMenuItems.length === 0 && menu.items.length > 0) {
      await db.migrationItem.update({
        where: { id: item.id },
        data: {
          status: "SKIPPED",
          errorMessage:
            "Shopify manages this customer-account menu separately on each store",
        },
      });
      await logEvent(
        job.id,
        "INFO",
        `Skipped Shopify-managed customer account menu "${menu.title}"`,
        { sourceId: item.sourceId },
      );
      continue;
    }

    const items: MenuItemCreateInput[] = [];
    for (const menuItem of portableMenuItems) {
      let resourceId = menuItem.resourceSourceId ?? undefined;
      if (resourceId) {
        resourceId = (await getMappingBySourceIdAnyType(storeConnectionId, resourceId)) ?? resourceId;
      }
      items.push({ title: menuItem.title, type: menuItem.type, url: menuItem.url ?? undefined, resourceId });
    }

    const handle = menu.handle === "main-menu" || menu.handle === "footer" ? `${menu.handle}-copy-${Date.now().toString(36)}` : menu.handle;

    try {
      if (existingMenu && conflictStrategy !== "CREATE_NEW") {
        const updated = await destAdmin.graphql<MenuMutationResponse>(
          MENU_UPDATE_MUTATION,
          { id: existingMenu.id, title: menu.title, handle: menu.handle, items },
          15,
        );
        if (updated.menuUpdate.userErrors.length > 0 || !updated.menuUpdate.menu) {
          throw new Error(joinUserErrors(updated.menuUpdate.userErrors, "Unknown menuUpdate error"));
        }
        await saveMapping({ storeConnectionId, resourceType: "menu", sourceId: item.sourceId, destinationId: existingMenu.id, sourceHandle: menu.handle, destinationHandle: updated.menuUpdate.menu.handle });
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId: existingMenu.id, errorMessage: null } });
        continue;
      }
      const result = await destAdmin.graphql<MenuCreateResponse>(MENU_CREATE_MUTATION, { title: menu.title, handle, items }, 15);
      if (result.menuCreate.userErrors.length > 0 || !result.menuCreate.menu) {
        const message = joinUserErrors(result.menuCreate?.userErrors, "Unknown menuCreate error");
        await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: message } });
        await logEvent(job.id, "ERROR", message, { itemId: item.id });
        continue;
      }
      const destinationId = result.menuCreate.menu.id;
      await saveMapping({ storeConnectionId, resourceType: "menu", sourceId: item.sourceId, destinationId, sourceHandle: menu.handle, destinationHandle: result.menuCreate.menu.handle });
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "COMPLETED", destinationId, errorMessage: null } });
      await logEvent(job.id, "INFO", `Migrated menu "${menu.title}"`, { sourceId: item.sourceId });
    } catch (error) {
      await db.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", errorMessage: errMsg(error) } });
    }
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
