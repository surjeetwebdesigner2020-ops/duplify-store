import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidShopDomain } from "./shop-domain";
import { REQUESTED_SCOPES } from "./scopes";

// Hand-rolled classic OAuth (authorization-code grant) for the *second* shop in
// a migration pair. The embedded shop gets tokens via App Bridge session-token
// exchange automatically (see shopify.server.ts / authenticate.admin) — but
// that only ever authenticates the single shop currently embedding this app
// instance. To also hold an offline token for the *other* shop the merchant
// wants to pair it with, we redirect the merchant's browser, top-level (not in
// an iframe — Shopify blocks framing another shop's OAuth consent screen), to
// that shop's own /admin/oauth/authorize, then exchange the returned code for
// a token ourselves. This is the same flow Shopify's classic (pre token-exchange)
// public apps used, still fully supported.
//
// `.server.ts` suffix matters here: it uses node:crypto, so it must never be
// pulled into the client bundle. isValidShopDomain lives in the sibling
// shop-domain.ts (no node imports) specifically so client components like
// app.connect.tsx can validate input without dragging this file along.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth consent screen

export type ExternalOAuthRole = "SOURCE" | "DESTINATION";

interface StatePayload {
  ownerShopId: string;
  ownerRole: ExternalOAuthRole;
  /** Shop domain that must complete this authorize — prevents shop-swap on callback. */
  expectedShop?: string;
  storeConnectionId: string | null;
  nonce: string;
  iat: number;
}

function getStateSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET is required to sign OAuth state");
  }
  return secret;
}

// Stateless, signed CSRF token: base64url(payload) + "." + hex HMAC signature.
// Avoids needing a server-side session store for a flow that spans two
// different top-level browser tabs/windows.
export function signState(payload: Omit<StatePayload, "iat">): string {
  const full: StatePayload = { ...payload, iat: Date.now() };
  const encoded = Buffer.from(JSON.stringify(full)).toString("base64url");
  const signature = createHmac("sha256", getStateSecret())
    .update(encoded)
    .digest("hex");
  return `${encoded}.${signature}`;
}

export function verifyState(state: string): StatePayload | null {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;

  const expected = createHmac("sha256", getStateSecret())
    .update(encoded)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return null;
  }

  const payload = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as StatePayload;

  if (Date.now() - payload.iat > STATE_TTL_MS) return null;

  return payload;
}

export function isExternalOAuthState(state: string): boolean {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<StatePayload>;
    return (
      typeof payload.ownerShopId === "string" &&
      (payload.ownerRole === "SOURCE" || payload.ownerRole === "DESTINATION") &&
      typeof payload.nonce === "string" &&
      typeof payload.iat === "number"
    );
  } catch {
    return false;
  }
}

export function buildAuthorizeUrl(params: {
  shop: string;
  state: string;
  redirectUri: string;
  scopes: readonly string[];
}): string {
  const url = new URL(`https://${params.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", process.env.SHOPIFY_API_KEY ?? "");
  url.searchParams.set("scope", params.scopes.join(","));
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

// Shopify's classic HMAC validation: every query param except hmac/signature,
// sorted, joined as key=value&key=value, HMAC-SHA256 with the API secret.
export function verifyCallbackHmac(searchParams: URLSearchParams): boolean {
  const hmac = searchParams.get("hmac");
  if (!hmac) return false;

  const pairs: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key === "hmac" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const message = pairs.join("&");

  const digest = createHmac("sha256", getStateSecret())
    .update(message)
    .digest("hex");

  const digestBuf = Buffer.from(digest, "hex");
  const hmacBuf = Buffer.from(hmac, "hex");
  return (
    digestBuf.length === hmacBuf.length && timingSafeEqual(digestBuf, hmacBuf)
  );
}

// Shared by auth.external.begin.tsx (redirects a same-session popup straight
// there) and api.connections.external-link.tsx (hands the URL back as text
// to copy/share — this final Shopify-hosted authorize URL, unlike our own
// /auth/external/begin, isn't tied to this app's session, so it's safe to
// open in a completely different browser/account than the one that generated
// it, as long as it's used within its 10-minute window).
export function buildExternalConnectAuthorizeUrl(params: {
  ownerShopId: string;
  shop: string;
  role: ExternalOAuthRole;
  appUrl: string;
}): string {
  const shop = params.shop.trim().toLowerCase();
  if (!isValidShopDomain(shop)) {
    throw new Response("Invalid shop domain. Expected format: your-store.myshopify.com", { status: 400 });
  }

  // /auth/callback is included in Shopify CLI's temporary-tunnel allow-list.
  // A custom callback path is not carried into that generated configuration.
  const redirectUri = new URL("/auth/callback", params.appUrl).toString();

  // ownerRole is the CURRENT (embedded) shop's role; the shop being
  // authorized takes the opposite role in the pair.
  const ownerRole: ExternalOAuthRole = params.role === "SOURCE" ? "DESTINATION" : "SOURCE";

  const state = signState({
    ownerShopId: params.ownerShopId,
    ownerRole,
    expectedShop: shop,
    storeConnectionId: null,
    nonce: crypto.randomUUID(),
  });

  return buildAuthorizeUrl({ shop, state, redirectUri, scopes: REQUESTED_SCOPES });
}

interface TokenExchangeResult {
  access_token: string;
  scope: string;
}

export async function exchangeCodeForToken(
  shop: string,
  code: string,
): Promise<TokenExchangeResult> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to exchange OAuth code for ${shop}: ${response.status} ${body}`,
    );
  }

  return (await response.json()) as TokenExchangeResult;
}
