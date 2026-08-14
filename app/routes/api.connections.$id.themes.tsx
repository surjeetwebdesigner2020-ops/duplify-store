import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  createAdminClient,
  ShopifyGraphqlError,
} from "../lib/shopify/admin-client";
import { parseGrantedScopes } from "../lib/shopify/scopes";
import { THEMES_BY_NAME_QUERY } from "../lib/shopify/queries/theme";
import {
  hydrateShopFromOfflineSession,
  refreshShopScopesIfStale,
} from "../lib/services/storeConnection.service";

interface ThemesResponse {
  themes: {
    edges: Array<{ node: { id: string; name: string; role: string } }>;
  };
}

function canReadThemes(grantedScope: string) {
  const granted = parseGrantedScopes(grantedScope);
  return granted.has("read_themes") || granted.has("write_themes");
}

function missingThemesScopeResponse() {
  return Response.json({ themes: [], missingScopes: ["read_themes"] });
}

function isThemesScopeError(error: unknown) {
  if (!(error instanceof ShopifyGraphqlError)) return false;
  return (
    error.message.includes("read_themes") ||
    (error.message.includes("Access denied") &&
      error.message.includes("themes field"))
  );
}

// Backs the theme picker in the New Migration form — lists every theme on
// the connection's *source* store so the merchant can migrate a specific
// (e.g. unpublished/staging) theme instead of always the live one.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const connection = await db.storeConnection.findFirst({
    where: {
      id: params.id,
      OR: [
        { ownerShopId: shop.id },
        { sourceShopId: shop.id },
        { destinationShopId: shop.id },
      ],
    },
    include: { sourceShop: true },
  });
  if (!connection) {
    return Response.json(
      { themes: [], error: "Connection not found" },
      { status: 404 },
    );
  }

  let sourceShop = connection.sourceShop;
  try {
    const hydrated = await hydrateShopFromOfflineSession(sourceShop.shopDomain);
    if (hydrated) {
      sourceShop = hydrated;
      await refreshShopScopesIfStale(hydrated);
      const refreshed = await db.shop.findUnique({
        where: { id: hydrated.id },
      });
      if (refreshed) sourceShop = refreshed;
    }
  } catch {
    // Best-effort — still try the themes query with whatever token we have.
  }

  // Prefer live API over the stored scope string. Shopify often grants
  // write_themes without listing read_themes; parseGrantedScopes covers that,
  // and a stale empty scope string should not block an installed source store.
  if (
    sourceShop.accessTokenEncrypted &&
    sourceShop.scope &&
    !canReadThemes(sourceShop.scope)
  ) {
    return missingThemesScopeResponse();
  }
  if (!sourceShop.accessTokenEncrypted) {
    return Response.json({
      themes: [],
      error: "Source store is not connected",
    });
  }

  const sourceAdmin = createAdminClient(sourceShop);
  let result: ThemesResponse;
  try {
    result = await sourceAdmin.graphql<ThemesResponse>(
      THEMES_BY_NAME_QUERY,
      undefined,
      10,
    );
  } catch (error) {
    if (isThemesScopeError(error)) {
      return missingThemesScopeResponse();
    }
    return Response.json({
      themes: [],
      error:
        error instanceof Error ? error.message : "Could not load themes",
    });
  }

  return Response.json({
    themes: (result.themes?.edges ?? []).map((e) => ({
      id: e.node.id,
      name: e.node.name,
      role: e.node.role,
    })),
  });
};
