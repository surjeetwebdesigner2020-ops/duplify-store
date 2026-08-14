import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { connectViaInstalledApp } from "../lib/services/installedPair.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const form = await request.formData();
  const otherShopDomain = String(
    form.get("otherShopDomain") ?? form.get("sourceShopDomain") ?? "",
  );
  const currentRoleRaw = String(form.get("currentRole") ?? "DESTINATION");
  const currentRole =
    currentRoleRaw === "SOURCE" ? "SOURCE" : "DESTINATION";

  return connectViaInstalledApp({
    ownerShopId: shop.id,
    otherShopDomain,
    currentRole,
  });
};
