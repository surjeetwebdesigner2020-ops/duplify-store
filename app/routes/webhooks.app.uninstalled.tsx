import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const shopRow = await db.shop.findUnique({ where: { shopDomain: shop } });
  if (shopRow) {
    await db.webhookEvent.create({
      data: {
        shopId: shopRow.id,
        topic,
        payload: payload as object,
        processedAt: new Date(),
      },
    });
    // Wipe credentials immediately so an uninstall cannot leave a usable
    // offline token in the DB until shop/redact (~48h later).
    await db.shop.update({
      where: { id: shopRow.id },
      data: {
        isActive: false,
        uninstalledAt: new Date(),
        accessTokenEncrypted: "",
        scope: "",
      },
    });
  }

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
