import db from "../../db.server";
import { encryptToken } from "../crypto/token-cipher";
import { isValidShopDomain } from "../shopify/shop-domain";
import { ADMIN_API_VERSION } from "../shopify/admin-client";
import { missingRequestedScopes } from "../shopify/scopes";

// Alternative to the OAuth popup flow for connecting the "other" store:
// paste an Admin API access token from a Custom App on that shop.

interface ShopCheckResponse {
  data?: { shop?: { name: string } };
  errors?: Array<{ message: string }>;
}

export type ConnectResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

export async function connectViaAccessToken(params: {
  ownerShopId: string;
  ownerRole: "SOURCE" | "DESTINATION";
  shopDomain: string;
  accessToken: string;
}): Promise<ConnectResult> {
  const shopDomain = params.shopDomain.trim().toLowerCase();
  const accessToken = params.accessToken.trim();

  if (!isValidShopDomain(shopDomain)) {
    return {
      ok: false,
      error: "Enter a valid shop domain, e.g. your-store.myshopify.com",
    };
  }
  if (!accessToken) {
    return { ok: false, error: "Enter an Admin API access token" };
  }

  const ownerShop = await db.shop.findUnique({
    where: { id: params.ownerShopId },
  });
  if (!ownerShop) {
    return { ok: false, error: "Current shop is not fully registered yet" };
  }
  if (shopDomain === ownerShop.shopDomain) {
    return {
      ok: false,
      error: "Source and destination stores must be different shops",
    };
  }

  let shopCheck: ShopCheckResponse;
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: "{ shop { name } }" }),
      },
    );
    if (response.status === 401 || response.status === 403) {
      const body = await response.text();
      console.error(
        `Manual connect token rejected for ${shopDomain}: ${response.status} ${body}`,
      );
      return {
        ok: false,
        error:
          "This access token was rejected by Shopify. Copy the full token (starts with shpat_) and make sure the custom app is installed on that store.",
      };
    }
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `Shopify returned an unexpected error (${response.status}): ${body.slice(0, 200)}`,
      };
    }
    shopCheck = (await response.json()) as ShopCheckResponse;
    if (shopCheck.errors && shopCheck.errors.length > 0) {
      return {
        ok: false,
        error: `Shopify rejected the request: ${shopCheck.errors.map((e) => e.message).join("; ")}`,
      };
    }
  } catch {
    return {
      ok: false,
      error:
        "Could not reach that shop. Double-check the domain and try again.",
    };
  }

  if (!shopCheck.data?.shop) {
    return {
      ok: false,
      error:
        "Shopify accepted the request but didn't return shop data — the token may be invalid.",
    };
  }

  let scope = "";
  try {
    const scopesResponse = await fetch(
      `https://${shopDomain}/admin/oauth/access_scopes.json`,
      {
        headers: { "X-Shopify-Access-Token": accessToken },
      },
    );
    if (scopesResponse.ok) {
      const body = (await scopesResponse.json()) as {
        access_scopes?: Array<{ handle: string }>;
      };
      scope = (body.access_scopes ?? []).map((s) => s.handle).join(",");
    }
  } catch {
    return {
      ok: false,
      error: "Could not verify the token's granted scopes. Try again.",
    };
  }

  if (!scope) {
    return {
      ok: false,
      error: "Could not read the token's granted scopes. Try again.",
    };
  }

  // Accept partial scopes; scan/PermissionBanner show what is still missing.
  const missingScopes = missingRequestedScopes(scope);
  if (missingScopes.length > 0) {
    console.warn(
      `Manual connect for ${shopDomain} granted partial scopes. Missing: ${missingScopes.join(",")}`,
    );
  }

  const externalShop = await db.shop.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      accessTokenEncrypted: encryptToken(accessToken),
      scope,
      isActive: true,
    },
    update: {
      accessTokenEncrypted: encryptToken(accessToken),
      scope,
      isActive: true,
      uninstalledAt: null,
    },
  });

  const sourceShopId =
    params.ownerRole === "SOURCE" ? ownerShop.id : externalShop.id;
  const destinationShopId =
    params.ownerRole === "DESTINATION" ? ownerShop.id : externalShop.id;

  await db.storeConnection.upsert({
    where: {
      sourceShopId_destinationShopId: { sourceShopId, destinationShopId },
    },
    create: {
      ownerShopId: ownerShop.id,
      sourceShopId,
      destinationShopId,
      status: "READY",
    },
    update: { status: "READY" },
  });

  return {
    ok: true,
    ...(missingScopes.length > 0
      ? {
          warning:
            "Connected. Some permissions are still missing — scan will show what still needs access.",
        }
      : {}),
  };
}
