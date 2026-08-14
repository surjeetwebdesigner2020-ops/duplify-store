import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  buildExternalConnectAuthorizeUrl,
  type ExternalOAuthRole,
} from "../lib/shopify/external-oauth.server";
import { externalOAuthAppUrl } from "../lib/shopify/app-url.server";

// Same link auth.external.begin.tsx would redirect to, but returned as JSON
// text to copy/share instead of being followed immediately — for connecting
// a store nobody at the keyboard right now has Shopify access to: copy this,
// send it to whoever does, they open it (or you open it in an
// already-logged-in-as-them Incognito window) and approve it there. Safe to
// hand off like this because approving it doesn't need this app's session —
// just to be logged into that shop's Shopify admin — and it expires in 10
// minutes if unused.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop")?.trim().toLowerCase();
  const role = url.searchParams.get("role") as ExternalOAuthRole | null;

  if (!shop) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }
  if (role !== "SOURCE" && role !== "DESTINATION") {
    return Response.json({ error: "Invalid or missing role parameter" }, { status: 400 });
  }
  if (shop === session.shop) {
    return Response.json({ error: "Source and destination stores must be different shops" }, { status: 400 });
  }

  const ownerShop = await db.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!ownerShop) {
    return Response.json({ error: "Current shop is not fully registered yet" }, { status: 409 });
  }

  try {
    const appUrl = externalOAuthAppUrl(request);
    const authorizeUrl = buildExternalConnectAuthorizeUrl({
      ownerShopId: ownerShop.id,
      shop,
      role,
      appUrl,
    });
    return Response.json({ url: authorizeUrl });
  } catch (error) {
    if (error instanceof Response) throw error;
    return Response.json({ error: "Could not build the connection link" }, { status: 500 });
  }
};
