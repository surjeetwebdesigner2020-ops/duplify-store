import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { declineStoreConnection } from "../lib/services/installedPair.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const connectionId = params.id;
  if (!connectionId) {
    return { ok: false as const, error: "Missing connection id" };
  }

  return declineStoreConnection({
    connectionId,
    actingShopId: shop.id,
  });
};
