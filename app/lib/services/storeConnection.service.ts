import db from "../../db.server";
import { encryptToken } from "../crypto/token-cipher";
import { createAdminClient } from "../shopify/admin-client";
// Ensures the currently-embedded shop has a `Shop` row. Normally this is
// created by the `afterAuth` hook in shopify.server.ts the moment OAuth
// completes, but loaders call this defensively (e.g. right after install,
// before the hook's write has necessarily committed).
export async function getOrCreateShop(shopDomain: string) {
  return db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, accessTokenEncrypted: "", scope: "" },
    update: {},
  });
}

/**
 * Mirror the embedded session into our Shop table on every app open so
 * permission checks (Overview banner, scan) see the real granted scopes —
 * not a stale empty row left behind by getOrCreateShop / pairing.
 */
export async function syncEmbeddedShopFromSession(session: {
  shop: string;
  accessToken?: string;
  scope?: string;
}) {
  const token = session.accessToken?.trim() ?? "";
  const scope = session.scope?.trim() ?? "";

  return db.shop.upsert({
    where: { shopDomain: session.shop },
    create: {
      shopDomain: session.shop,
      accessTokenEncrypted: token ? encryptToken(token) : "",
      scope,
      isActive: true,
      uninstalledAt: null,
    },
    update: {
      ...(token ? { accessTokenEncrypted: encryptToken(token) } : {}),
      ...(scope ? { scope } : {}),
      isActive: true,
      uninstalledAt: null,
    },
  });
}

/**
 * If Shop row is missing a token/scope but Shopify Session storage has an
 * offline session for that shop, copy it over. This heals pairs where the
 * merchant opened the app but Shop.scope/token stayed blank.
 */
export async function hydrateShopFromOfflineSession(shopDomain: string) {
  try {
    const shop = await db.shop.findUnique({ where: { shopDomain } });
    const offlineSession =
      (await db.session.findUnique({
        where: { id: `offline_${shopDomain}` },
      })) ??
      (await db.session.findFirst({
        where: { shop: shopDomain, isOnline: false },
      })) ??
      (await db.session.findFirst({
        where: { shop: shopDomain },
      }));

    if (!offlineSession?.accessToken) return shop;

    const scope = offlineSession.scope?.trim() || shop?.scope || "";
    return await db.shop.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        accessTokenEncrypted: encryptToken(offlineSession.accessToken),
        scope,
        isActive: true,
        uninstalledAt: null,
      },
      update: {
        accessTokenEncrypted: encryptToken(offlineSession.accessToken),
        ...(scope ? { scope } : {}),
        isActive: true,
        uninstalledAt: null,
      },
    });
  } catch {
    return null;
  }
}

/**
 * If a paired shop has a token but an empty/stale scope string (common after
 * pairing), refresh scopes from Shopify so Overview stops saying
 * "needs Duplify installed".
 */
export async function refreshShopScopesIfStale(shop: {
  id: string;
  shopDomain: string;
  scope: string;
  accessTokenEncrypted: string;
  isActive: boolean;
  uninstalledAt: Date | null;
}): Promise<string> {
  try {
    // Prefer Session-table token when Shop token is blank.
    if (!shop.accessTokenEncrypted) {
      const hydrated = await hydrateShopFromOfflineSession(shop.shopDomain);
      if (hydrated?.accessTokenEncrypted) {
        shop = {
          id: hydrated.id,
          shopDomain: hydrated.shopDomain,
          scope: hydrated.scope,
          accessTokenEncrypted: hydrated.accessTokenEncrypted,
          isActive: hydrated.isActive,
          uninstalledAt: hydrated.uninstalledAt,
        };
      }
    }

    if (!shop.isActive || shop.uninstalledAt || !shop.accessTokenEncrypted) {
      return shop.scope;
    }

    // Always refresh from Shopify — never trust a stale "looks ready" scope string.
    const admin = createAdminClient(shop);
    const result = await admin.graphql<{
      currentAppInstallation: {
        accessScopes: Array<{ handle: string }>;
      };
    }>(
      `#graphql
        query duplifyCurrentAccessScopes {
          currentAppInstallation {
            accessScopes { handle }
          }
        }
      `,
      undefined,
      2,
    );
    const liveScope = result.currentAppInstallation.accessScopes
      .map((scope) => scope.handle)
      .filter(Boolean)
      .join(",");
    if (!liveScope) return shop.scope;

    await db.shop.update({
      where: { id: shop.id },
      data: { scope: liveScope, isActive: true, uninstalledAt: null },
    });
    return liveScope;
  } catch {
    return shop.scope;
  }
}

export async function listConnectionsForOwner(ownerShopId: string) {
  return db.storeConnection.findMany({
    where: {
      status: { not: "ARCHIVED" },
      OR: [
        { ownerShopId },
        { sourceShopId: ownerShopId },
        { destinationShopId: ownerShopId },
      ],
    },
    include: { sourceShop: true, destinationShop: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getConnection(id: string) {
  return db.storeConnection.findUnique({
    where: { id },
    include: { sourceShop: true, destinationShop: true },
  });
}

/** Either store in a pair (or the connection owner) can open migration pages. */
export function migrationJobForShopWhere(jobId: string, shopId: string) {
  return {
    id: jobId,
    storeConnection: {
      OR: [
        { ownerShopId: shopId },
        { sourceShopId: shopId },
        { destinationShopId: shopId },
      ],
    },
  };
}

/** Only the shop that created the pair may mutate its migration jobs. */
export function migrationJobForOwnerWhere(jobId: string, shopId: string) {
  return {
    id: jobId,
    storeConnection: { ownerShopId: shopId },
  };
}

/** Owner-only mutation that also requires an approved, active store pair. */
export function migrationJobForOwnerReadyWhere(jobId: string, shopId: string) {
  return {
    id: jobId,
    storeConnection: { ownerShopId: shopId, status: "READY" as const },
  };
}
