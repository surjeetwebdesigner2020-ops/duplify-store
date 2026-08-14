import { resourceTypesForSelections, type ScanSummary } from "./scan.service";
import {
  missingReadScopes,
  missingScopes,
  shopCanMigrate,
  shopIsConnected,
} from "../shopify/scopes";

export interface PermissionRequirement {
  resourceType: string;
  missing: string[];
  shopRole?: "source" | "destination";
  shopDomain?: string;
  /** false = app not connected on that shop (reconnect), not a scopes.request loop */
  installed?: boolean;
}

interface StoreScopes {
  sourceScope: string;
  destinationScope: string;
  sourceShopDomain: string;
  destinationShopDomain: string;
  sourceConnected?: boolean;
  destinationConnected?: boolean;
}

/**
 * Missing scopes for the selected resources.
 * - Disconnected shop → single "reconnect" signal
 * - Connected shop → real per-resource missing scopes (never blank just because
 *   shopCanMigrate was true on a stale scope string)
 */
export function liveMissingPermissions(
  selectedResources: string[],
  stores: StoreScopes,
): PermissionRequirement[] {
  const resourceTypes = resourceTypesForSelections(selectedResources);
  const sourceConnected = stores.sourceConnected === true;
  const destinationConnected = stores.destinationConnected === true;

  return [
    ...resourceTypes.map((resourceType) => ({
      resourceType,
      missing: !sourceConnected
        ? ["reconnect"]
        : missingReadScopes(resourceType, stores.sourceScope),
      shopRole: "source" as const,
      shopDomain: stores.sourceShopDomain,
      installed: sourceConnected,
    })),
    ...resourceTypes.map((resourceType) => ({
      resourceType,
      missing: !destinationConnected
        ? ["reconnect"]
        : missingScopes(resourceType, stores.destinationScope),
      shopRole: "destination" as const,
      shopDomain: stores.destinationShopDomain,
      installed: destinationConnected,
    })),
  ].filter((requirement) => requirement.missing.length > 0);
}

export function liveMissingAppPermissions(
  stores: StoreScopes,
): PermissionRequirement[] {
  const sourceConnected = stores.sourceConnected === true;
  const destinationConnected = stores.destinationConnected === true;

  const requirements: PermissionRequirement[] = [];

  if (!sourceConnected && !shopCanMigrate(stores.sourceScope)) {
    requirements.push({
      resourceType: "app permissions",
      missing: ["reconnect"],
      shopRole: "source",
      shopDomain: stores.sourceShopDomain,
      installed: false,
    });
  }

  if (!destinationConnected && !shopCanMigrate(stores.destinationScope)) {
    requirements.push({
      resourceType: "app permissions",
      missing: ["reconnect"],
      shopRole: "destination",
      shopDomain: stores.destinationShopDomain,
      installed: false,
    });
  }

  return requirements;
}

export function countLiveMissingPermissions(
  selectedResources: string[],
  stores: StoreScopes,
) {
  return liveMissingPermissions(selectedResources, stores).length;
}

export function scanHadMissingPermissions(scanSummary: ScanSummary | null) {
  return (
    scanSummary?.requiredPermissions.some(
      (permission) => permission.missing.length > 0,
    ) ?? false
  );
}

export function needsPermissionRescan(
  scanSummary: ScanSummary | null,
  selectedResources: string[],
  stores: StoreScopes,
) {
  return (
    scanHadMissingPermissions(scanSummary) &&
    liveMissingPermissions(selectedResources, stores).length === 0
  );
}

export function storeScopesFromConnection(connection: {
  sourceShop: {
    shopDomain: string;
    scope: string;
    isActive: boolean;
    accessTokenEncrypted: string | null;
    uninstalledAt: Date | null;
  };
  destinationShop: {
    shopDomain: string;
    scope: string;
    isActive: boolean;
    accessTokenEncrypted: string | null;
    uninstalledAt: Date | null;
  };
}): StoreScopes {
  return {
    sourceScope: connection.sourceShop.scope,
    destinationScope: connection.destinationShop.scope,
    sourceShopDomain: connection.sourceShop.shopDomain,
    destinationShopDomain: connection.destinationShop.shopDomain,
    sourceConnected: shopIsConnected(connection.sourceShop),
    destinationConnected: shopIsConnected(connection.destinationShop),
  };
}

/** History/Overview: 0 records after auth/reconnect block is not an empty store. */
export function scanSummaryLooksBlocked(scanSummary: unknown): boolean {
  if (!scanSummary || typeof scanSummary !== "object") return false;
  const summary = scanSummary as {
    resources?: Record<string, { unsupported?: string[] }>;
    requiredPermissions?: Array<{ missing?: string[] }>;
  };
  if (
    summary.requiredPermissions?.some((permission) =>
      (permission.missing ?? []).some(
        (scope) => scope === "reconnect" || /reconnect/i.test(scope),
      ),
    )
  ) {
    return true;
  }
  const unsupported = Object.values(summary.resources ?? {}).flatMap(
    (resource) => resource.unsupported ?? [],
  );
  return unsupported.some((message) =>
    /reconnect|not connected|expired|invalid api key|access token/i.test(
      message,
    ),
  );
}
