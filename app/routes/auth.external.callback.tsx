import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { encryptToken } from "../lib/crypto/token-cipher";
import {
  exchangeCodeForToken,
  verifyCallbackHmac,
  verifyState,
} from "../lib/shopify/external-oauth.server";
import { isValidShopDomain } from "../lib/shopify/shop-domain";
import { missingRequestedScopes } from "../lib/shopify/scopes";

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function confirmationPage(message: string, ok: boolean) {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Duplify Store</title></head>
<body style="font-family: -apple-system, Inter, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; background:#f6f6f7;">
  <div style="max-width:420px; text-align:center; padding:32px; background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <h2 style="color:${ok ? "#008060" : "#d72c0d"}; margin-top:0;">${ok ? "Store connected" : "Connection failed"}</h2>
    <p style="color:#4a4a4a;">${message}</p>
    <p style="color:#6d7175; font-size:13px;">You can close this tab and return to Duplify Store.</p>
  </div>
  <script>
    if (window.opener) {
      try { window.opener.postMessage({ source: "duplify-external-oauth", ok: ${ok} }, "*"); } catch (e) {}
    }
    setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);
  </script>
</body>
</html>`,
    ok ? 200 : 400,
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop")?.trim().toLowerCase();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!shop || !isValidShopDomain(shop) || !code || !state) {
    return confirmationPage(
      "This authorization link is missing required parameters.",
      false,
    );
  }

  if (!verifyCallbackHmac(url.searchParams)) {
    return confirmationPage(
      "This authorization link failed security verification (invalid HMAC).",
      false,
    );
  }

  const statePayload = verifyState(state);
  if (!statePayload) {
    return confirmationPage(
      "This authorization link has expired or is invalid. Please restart the connection from Duplify Store.",
      false,
    );
  }

  if (
    statePayload.expectedShop &&
    shop !== statePayload.expectedShop.trim().toLowerCase()
  ) {
    return confirmationPage(
      "This authorization link was issued for a different store. Please restart the connection from Duplify Store.",
      false,
    );
  }

  const ownerShop = await db.shop.findUnique({
    where: { id: statePayload.ownerShopId },
  });
  if (!ownerShop) {
    return confirmationPage(
      "The store that requested this connection could not be found.",
      false,
    );
  }

  let tokenResult;
  try {
    tokenResult = await exchangeCodeForToken(shop, code);
  } catch (error) {
    console.error("External OAuth token exchange failed", error);
    return confirmationPage(
      "Shopify rejected the authorization code. Please try connecting again.",
      false,
    );
  }

  // Save whatever Shopify granted. Scan/PermissionBanner already tell the
  // merchant which remaining permissions are needed for specific resources.
  const missingScopes = missingRequestedScopes(tokenResult.scope);
  if (missingScopes.length > 0) {
    console.warn(
      `External OAuth for ${shop} granted partial scopes. Missing: ${missingScopes.join(",")}`,
    );
  }

  const externalShop = await db.shop.upsert({
    where: { shopDomain: shop },
    create: {
      shopDomain: shop,
      accessTokenEncrypted: encryptToken(tokenResult.access_token),
      scope: tokenResult.scope,
      isActive: true,
    },
    update: {
      accessTokenEncrypted: encryptToken(tokenResult.access_token),
      scope: tokenResult.scope,
      isActive: true,
      uninstalledAt: null,
    },
  });

  const sourceShopId =
    statePayload.ownerRole === "SOURCE" ? ownerShop.id : externalShop.id;
  const destinationShopId =
    statePayload.ownerRole === "DESTINATION" ? ownerShop.id : externalShop.id;

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
    update: {
      status: "READY",
    },
  });

  const connectedRole =
    statePayload.ownerRole === "SOURCE" ? "destination" : "source";
  return confirmationPage(
    missingScopes.length > 0
      ? `${shop} is connected as the ${connectedRole} store. Some permissions are still missing — return to Duplify Store and follow the approval steps shown there.`
      : `${shop} is now connected as the ${connectedRole} store.`,
    true,
  );
};
