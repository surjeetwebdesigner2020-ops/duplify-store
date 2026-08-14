// Pure, isomorphic (no node built-ins) so it's safe to import from
// client-rendered route components like app.connect.tsx — everything else in
// external-oauth.server.ts uses node:crypto and must stay server-only.
const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/** Accepts pasted URLs like https://shop.myshopify.com/admin and normalizes. */
export function normalizeShopDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "");
  value = value.split("/")[0] ?? value;
  value = value.split("?")[0] ?? value;
  return value;
}

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(normalizeShopDomain(shop));
}
