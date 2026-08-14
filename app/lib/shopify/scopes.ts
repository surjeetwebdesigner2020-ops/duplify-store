// Central registry of which Shopify Admin API scopes each migration resource
// type needs, tagged by the phase that ships it. Used by shopify.server.ts to
// build the requested scope list and by scan.service.ts to warn the merchant
// about missing permissions during the pre-migration scan.

export const PHASE_1_SCOPES = [
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
] as const;

export const PHASE_2_SCOPES = [
  "read_customers",
  "write_customers",
  "read_content",
  "write_content",
  "read_files",
  "write_files",
  "read_metaobjects",
  "write_metaobjects",
  "read_metaobject_definitions",
  "write_metaobject_definitions",
  "read_online_store_navigation",
  "write_online_store_navigation",
] as const;

export const PHASE_3_SCOPES = [
  "read_discounts",
  "write_discounts",
  "read_orders",
  "read_all_orders",
  "write_orders",
  "read_draft_orders",
  "write_draft_orders",
  "read_themes",
  "write_themes",
] as const;

// Shopify will not grant these via scopes.request() until Partner Dashboard
// access is approved. Keep them out of "Update this store" / missing banners
// so the button does not open a broken blank page.
export const PROTECTED_SCOPES = ["read_all_orders"] as const;

export function isRequestableScope(scope: string): boolean {
  return !(PROTECTED_SCOPES as readonly string[]).includes(scope);
}

// All phases are now requested — Phase 1/2/3 resource types all ship in this
// build. Bumping this list re-triggers Shopify's scope-consent screen for
// already-installed shops (handled by the app/scopes_update webhook).
export const REQUESTED_SCOPES = [
  ...PHASE_1_SCOPES,
  ...PHASE_2_SCOPES,
  ...PHASE_3_SCOPES,
];

/** Scopes declared in shopify.app.toml / OAuth — everything except Partner-gated. */
export const PUBLISHED_SCOPES = REQUESTED_SCOPES.filter(isRequestableScope);

export const RESOURCE_TYPE_SCOPES: Record<string, readonly string[]> = {
  product: ["read_products", "write_products"],
  variant: ["read_products", "write_products"],
  image: ["read_products", "write_products"],
  inventory: [
    "read_products",
    "read_inventory",
    "write_inventory",
    "read_locations",
  ],
  collection: ["read_products", "write_products"],
  customer: ["read_customers", "write_customers"],
  page: ["read_content", "write_content"],
  blog: ["read_content", "write_content"],
  article: ["read_content", "write_content"],
  file: ["read_files", "write_files"],
  metafield_definition: [
    "read_products",
    "write_products",
    "read_customers",
    "write_customers",
    "read_content",
    "write_content",
    "read_orders",
    "write_orders",
  ],
  metaobject_definition: [
    "read_metaobject_definitions",
    "write_metaobject_definitions",
  ],
  metaobject: ["read_metaobjects", "write_metaobjects"],
  menu: ["read_online_store_navigation", "write_online_store_navigation"],
  discount: ["read_discounts", "write_discounts"],
  order: [
    "read_orders",
    "read_all_orders",
    "read_draft_orders",
    "write_draft_orders",
  ],
  theme: ["read_themes", "write_themes"],
};

export function parseGrantedScopes(grantedScope: string): Set<string> {
  const granted = new Set(
    grantedScope
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  );

  // Shopify may return write_* without the matching read_*. For our access
  // checks, write access is enough to cover the matching read scope.
  for (const scope of [...granted]) {
    if (scope.startsWith("write_")) {
      granted.add(`read_${scope.slice("write_".length)}`);
    }
  }

  // Inventory / product installs almost always include location access; Shopify
  // often omits read_locations from the compressed scope string.
  if (
    granted.has("write_inventory") ||
    granted.has("read_inventory") ||
    granted.has("write_products") ||
    granted.has("read_products")
  ) {
    granted.add("read_locations");
  }

  return granted;
}

export function missingRequestedScopes(grantedScope: string): string[] {
  const granted = parseGrantedScopes(grantedScope);
  // Exclude protected scopes from "blocking" missing checks — merchants
  // cannot approve them from inside the app until Shopify Partner approves.
  return REQUESTED_SCOPES.filter(
    (scope) => !granted.has(scope) && isRequestableScope(scope),
  );
}

/**
 * True when the shop finished OAuth with real migration access.
 * Used to avoid forcing clients through manual "Grant permissions" flows —
 * install already requested the full published scope set.
 */
export function shopCanMigrate(grantedScope: string): boolean {
  const granted = parseGrantedScopes(grantedScope);
  if (granted.size === 0) return false;
  return (
    granted.has("write_products") ||
    granted.has("read_products") ||
    granted.has("write_customers") ||
    granted.has("write_content") ||
    granted.has("write_themes")
  );
}

/** App is installed and has an offline token — even if scope string is stale. */
export function shopIsConnected(shop: {
  isActive: boolean;
  accessTokenEncrypted: string | null | undefined;
  uninstalledAt?: Date | null;
}): boolean {
  return Boolean(
    shop.isActive && shop.accessTokenEncrypted && !shop.uninstalledAt,
  );
}

export function missingScopes(
  resourceType: string,
  grantedScope: string,
): string[] {
  const granted = parseGrantedScopes(grantedScope);
  const required = RESOURCE_TYPE_SCOPES[resourceType] ?? [];
  return required.filter(
    (scope) => !granted.has(scope) && isRequestableScope(scope),
  );
}

export function missingReadScopes(
  resourceType: string,
  grantedScope: string,
): string[] {
  const granted = parseGrantedScopes(grantedScope);
  const required = RESOURCE_TYPE_SCOPES[resourceType] ?? [];
  return required.filter(
    (scope) =>
      scope.startsWith("read_") &&
      !granted.has(scope) &&
      isRequestableScope(scope),
  );
}
