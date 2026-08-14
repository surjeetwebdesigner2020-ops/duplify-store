import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { connectViaAccessToken } from "../lib/services/manualConnect.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });

  const form = await request.formData();
  const shopDomain = String(form.get("shopDomain") ?? "");
  const accessToken = String(form.get("accessToken") ?? "");
  const ownerRole = String(form.get("ownerRole") ?? "DESTINATION") as "SOURCE" | "DESTINATION";

  const result = await connectViaAccessToken({
    ownerShopId: shop.id,
    ownerRole,
    shopDomain,
    accessToken,
  });

  return result;
};
