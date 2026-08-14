import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  buildExternalConnectAuthorizeUrl,
  type ExternalOAuthRole,
} from "../lib/shopify/external-oauth.server";
import { externalOAuthAppUrl } from "../lib/shopify/app-url.server";

// Begins the non-embedded OAuth flow for the "other" store in a migration
// pair. Opened top-level (new tab), not fetched from within the iframe —
// Shopify's OAuth consent screen refuses to render inside another shop's
// frame, so this route only ever makes sense navigated to directly.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop")?.trim().toLowerCase();
  const role = url.searchParams.get("role") as ExternalOAuthRole | null;

  if (!shop) {
    throw new Response("Missing shop parameter", { status: 400 });
  }
  if (role !== "SOURCE" && role !== "DESTINATION") {
    throw new Response("Invalid or missing role parameter", { status: 400 });
  }
  if (shop === session.shop) {
    throw new Response("Source and destination stores must be different shops", { status: 400 });
  }

  const ownerShop = await db.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!ownerShop) {
    // afterAuth always upserts this on install; if it's missing the embedded
    // OAuth hook never ran for this shop.
    throw new Response("Current shop is not fully registered yet", { status: 409 });
  }

  const appUrl = externalOAuthAppUrl(request);
  const authorizeUrl = buildExternalConnectAuthorizeUrl({
    ownerShopId: ownerShop.id,
    shop,
    role,
    appUrl,
  });

  return redirect(authorizeUrl);
};
