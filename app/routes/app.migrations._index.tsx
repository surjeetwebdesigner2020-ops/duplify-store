import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
  Form,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listMigrationJobs } from "../lib/services/migrationJob.service";
import { countLiveMissingPermissions, scanSummaryLooksBlocked } from "../lib/services/permissionStatus.server";
import { shopIsConnected } from "../lib/shopify/scopes";
import { MigrationList } from "../components/dashboard/MigrationList";
import { EmptyState } from "../components/shared/EmptyState";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const url = new URL(request.url);
  const statusRaw = url.searchParams.get("status") || "";
  const typeRaw = url.searchParams.get("type") || "";
  const search = url.searchParams.get("q") || undefined;

  const VALID_STATUSES = new Set([
    "DRAFT",
    "SCANNING",
    "SCANNED",
    "QUEUED",
    "RUNNING",
    "PAUSED",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ]);
  const VALID_TYPES = new Set([
    "FULL",
    "PRODUCTS",
    "COLLECTIONS",
    "CUSTOMERS",
    "CONTENT",
    "THEME",
    "CUSTOM",
  ]);

  const status = VALID_STATUSES.has(statusRaw) ? statusRaw : undefined;
  const type = VALID_TYPES.has(typeRaw) ? typeRaw : undefined;

  const rawJobs = await listMigrationJobs({
    ownerShopId: shop.id,
    status: status as never,
    type: type as never,
    search,
  });
  const jobs = collapseDuplicateBlockedScans(rawJobs);

  return {
    jobs: jobs.map((j) => {
      const sourceConnected = shopIsConnected(j.storeConnection.sourceShop);
      const destinationConnected = shopIsConnected(
        j.storeConnection.destinationShop,
      );
      const scanBlocked =
        scanSummaryLooksBlocked(j.scanSummary) && !sourceConnected;
      return {
        id: j.id,
        type: j.type,
        status: j.status,
        source: j.storeConnection.sourceShop.shopDomain,
        destination: j.storeConnection.destinationShop.shopDomain,
        totalRecords: j.totalRecords,
        completedRecords: j.completedRecords,
        failedRecords: j.failedRecords,
        missingPermissionsCount: countMissingPermissions(j, {
          sourceConnected,
          destinationConnected,
        }),
        scanBlocked,
        createdAt: j.createdAt,
      };
    }),
  };
};

function countMissingPermissions(
  job: {
    selectedResources: unknown;
    storeConnection: {
      sourceShop: { scope: string; shopDomain: string };
      destinationShop: { scope: string; shopDomain: string };
    };
  },
  connected?: { sourceConnected: boolean; destinationConnected: boolean },
) {
  return countLiveMissingPermissions(normalizeStrings(job.selectedResources), {
    sourceScope: job.storeConnection.sourceShop.scope,
    destinationScope: job.storeConnection.destinationShop.scope,
    sourceShopDomain: job.storeConnection.sourceShop.shopDomain,
    destinationShopDomain: job.storeConnection.destinationShop.shopDomain,
    sourceConnected: connected?.sourceConnected,
    destinationConnected: connected?.destinationConnected,
  });
}

function normalizeStrings(value: unknown) {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function collapseDuplicateBlockedScans<
  T extends {
    status: string;
    storeConnectionId: string;
    type: string;
    totalRecords: number;
    selectedResources: unknown;
    scanSummary: unknown;
    storeConnection: {
      sourceShop: {
        scope: string;
        shopDomain: string;
        isActive: boolean;
        accessTokenEncrypted: string | null;
        uninstalledAt: Date | null;
      };
      destinationShop: {
        scope: string;
        shopDomain: string;
        isActive: boolean;
        accessTokenEncrypted: string | null;
        uninstalledAt: Date | null;
      };
    };
  },
>(jobs: T[]) {
  const seen = new Set<string>();

  return jobs.filter((job) => {
    const missingPermissionsCount = countMissingPermissions(job, {
      sourceConnected: shopIsConnected(job.storeConnection.sourceShop),
      destinationConnected: shopIsConnected(job.storeConnection.destinationShop),
    });
    const isBlockedScan =
      job.status === "SCANNED" &&
      job.totalRecords === 0 &&
      missingPermissionsCount > 0;

    if (!isBlockedScan) return true;

    const key = [
      job.storeConnectionId,
      job.type,
      normalizeStrings(job.selectedResources).join("|"),
    ].join(":");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function MigrationHistory() {
  const { jobs } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const hasLiveJobs = jobs.some((job) =>
    ["SCANNING", "QUEUED", "RUNNING"].includes(job.status),
  );

  useEffect(() => {
    if (!hasLiveJobs) return;
    const interval = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(interval);
  }, [hasLiveJobs, revalidator]);

  return (
    <s-page heading="Migration history" inlineSize="large">
      <s-section heading="Filters">
        <Form method="get">
          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "2 1 240px", minWidth: "200px" }}>
              <s-search-field
                name="q"
                label="Search by shop domain"
                value={searchParams.get("q") ?? ""}
              ></s-search-field>
            </div>
            <div style={{ flex: "1 1 160px", minWidth: "140px" }}>
              <s-select
                name="status"
                label="Status"
                value={searchParams.get("status") || "ALL"}
              >
                <s-option value="ALL">Any status</s-option>
                <s-option value="RUNNING">Running</s-option>
                <s-option value="COMPLETED">Completed</s-option>
                <s-option value="FAILED">Failed</s-option>
                <s-option value="CANCELLED">Cancelled</s-option>
              </s-select>
            </div>
            <div style={{ flex: "1 1 160px", minWidth: "140px" }}>
              <s-select
                name="type"
                label="Type"
                value={searchParams.get("type") || "ALL"}
              >
                <s-option value="ALL">Any type</s-option>
                <s-option value="FULL">Full store</s-option>
                <s-option value="PRODUCTS">Products</s-option>
                <s-option value="COLLECTIONS">Collections</s-option>
                <s-option value="CUSTOM">Custom</s-option>
              </s-select>
            </div>
            <s-button type="submit">Apply</s-button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Migrations">
        {jobs.length === 0 ? (
          <EmptyState
            heading="No migrations found"
            message="Try adjusting your filters, or start a new migration."
          />
        ) : (
          <MigrationList jobs={jobs} showFailed />
        )}
      </s-section>
    </s-page>
  );
}
