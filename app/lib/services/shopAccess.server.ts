import {
  createAdminClient,
  isShopifyAuthError,
  type AdminClient,
} from "../shopify/admin-client";
import db from "../../db.server";
import { hydrateShopFromOfflineSession } from "./storeConnection.service";

const SHOP_PING = `#graphql
  query duplifyShopAccessPing {
    shop { name }
  }
`;

/**
 * Confirms the stored offline token still works against Shopify.
 * Returns null when OK, or the shop domain that needs reconnect.
 */
export async function verifyShopAdminAccess(shop: {
  id: string;
  shopDomain: string;
  accessTokenEncrypted: string;
}): Promise<string | null> {
  if (!shop.accessTokenEncrypted) return shop.shopDomain;

  try {
    const admin = createAdminClient(shop);
    await admin.graphql<{ shop: { name: string } }>(SHOP_PING, undefined, 1);
    return null;
  } catch (error) {
    // Network errors, throttling and Shopify outages must never revoke a
    // perfectly valid stored credential. Only confirmed auth failures may
    // trigger the session-heal/invalidation path below.
    if (!isShopifyAuthError(error)) throw error;

    // One heal attempt from Session storage, then re-ping.
    try {
      const hydrated = await hydrateShopFromOfflineSession(shop.shopDomain);
      if (hydrated?.accessTokenEncrypted) {
        const admin = createAdminClient(hydrated);
        await admin.graphql<{ shop: { name: string } }>(SHOP_PING, undefined, 1);
        return null;
      }
    } catch {
      // fall through
    }

    try {
      await db.shop.update({
        where: { id: shop.id },
        data: { accessTokenEncrypted: "", scope: "" },
      });
    } catch {
      // best-effort
    }

    return shop.shopDomain;
  }
}

export async function verifyMigrationStoreAccess(connection: {
  sourceShop: {
    id: string;
    shopDomain: string;
    accessTokenEncrypted: string;
  };
  destinationShop: {
    id: string;
    shopDomain: string;
    accessTokenEncrypted: string;
  };
}): Promise<string | null> {
  const sourceBad = await verifyShopAdminAccess(connection.sourceShop);
  if (sourceBad) return sourceBad;
  return verifyShopAdminAccess(connection.destinationShop);
}

/** Used by processors that already have an AdminClient. */
export async function pingAdminAccess(admin: AdminClient): Promise<boolean> {
  try {
    await admin.graphql<{ shop: { name: string } }>(SHOP_PING, undefined, 1);
    return true;
  } catch {
    return false;
  }
}
