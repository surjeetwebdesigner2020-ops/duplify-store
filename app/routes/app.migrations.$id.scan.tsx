import { useEffect, useRef } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import type { ScanSummary } from "../lib/services/scan.service";
import { StatCard } from "../components/dashboard/StatCard";
import { StatusBadge } from "../components/dashboard/StatusBadge";
import { PermissionBanner } from "../components/dashboard/PermissionBanner";
import { IndeterminateProgressBar } from "../components/dashboard/IndeterminateProgressBar";
import {
  liveMissingAppPermissions,
  needsPermissionRescan,
  storeScopesFromConnection,
} from "../lib/services/permissionStatus.server";
import {
  hydrateShopFromOfflineSession,
  migrationJobForOwnerWhere,
  refreshShopScopesIfStale,
} from "../lib/services/storeConnection.service";
import { shopIsConnected } from "../lib/shopify/scopes";

// Recover scans that were queued while no worker was online.
const recoveringScans = new Set<string>();

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const job = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
    include: {
      storeConnection: { include: { sourceShop: true, destinationShop: true } },
    },
  });
  if (!job) {
    throw redirect("/app/migrations");
  }

  if (job.status === "SCANNING" && !recoveringScans.has(job.id)) {
    recoveringScans.add(job.id);
    void import("../lib/services/scan.service")
      .then(({ runScan }) => runScan(job.id))
      .catch((error) => {
        console.error(`[scan-recover] Inline scan failed for ${job.id}`, error);
      })
      .finally(() => {
        recoveringScans.delete(job.id);
      });
  }

  // Heal tokens/scopes before deciding whether to show reconnect UI.
  try {
    await Promise.all([
      hydrateShopFromOfflineSession(job.storeConnection.sourceShop.shopDomain)
        .then(async (hydrated) => {
          if (hydrated) await refreshShopScopesIfStale(hydrated);
        })
        .catch(() => undefined),
      hydrateShopFromOfflineSession(
        job.storeConnection.destinationShop.shopDomain,
      )
        .then(async (hydrated) => {
          if (hydrated) await refreshShopScopesIfStale(hydrated);
        })
        .catch(() => undefined),
    ]);
  } catch {
    // Best-effort.
  }

  const freshJob = await db.migrationJob.findFirst({
    where: migrationJobForOwnerWhere(params.id!, shop.id),
    include: {
      storeConnection: { include: { sourceShop: true, destinationShop: true } },
    },
  });
  if (!freshJob) {
    throw redirect("/app/migrations");
  }

  const [failureLogs, failedGroups] =
    freshJob.status === "FAILED"
      ? await Promise.all([
          db.migrationLog.findMany({
            where: { migrationJobId: freshJob.id, level: "ERROR" },
            orderBy: { createdAt: "desc" },
            take: 5,
          }),
          db.migrationItem.groupBy({
            by: ["stage", "resourceType"],
            where: { migrationJobId: freshJob.id, status: "FAILED" },
            _count: { _all: true },
            orderBy: { _count: { id: "desc" } },
          }),
        ])
      : [[], []];

  const storeScopes = storeScopesFromConnection(freshJob.storeConnection);
  const sourceNeedsReconnect = !shopIsConnected(
    freshJob.storeConnection.sourceShop,
  );
  const destinationNeedsReconnect = !shopIsConnected(
    freshJob.storeConnection.destinationShop,
  );
  const protectedCustomerDataReviewUrl =
    process.env.SHOPIFY_PARTNERS_REVIEW_URL ||
    process.env.SHOPIFY_PROTECTED_CUSTOMER_DATA_URL ||
    "https://partners.shopify.com/192111910/apps/410803372033/customer_data";

  return {
    currentShopDomain: session.shop,
    job: {
      id: freshJob.id,
      status: freshJob.status,
      type: freshJob.type,
      currentStage: freshJob.currentStage,
      failedRecords: freshJob.failedRecords,
      selectedResources: freshJob.selectedResources as string[],
      scanSummary: freshJob.scanSummary as ScanSummary | null,
      missingPermissions: liveMissingAppPermissions(storeScopes),
      sourceNeedsReconnect,
      destinationNeedsReconnect,
      protectedCustomerDataReviewUrl,
      needsPermissionRescan: needsPermissionRescan(
        freshJob.scanSummary as ScanSummary | null,
        freshJob.selectedResources as string[],
        storeScopes,
      ),
      source: freshJob.storeConnection.sourceShop.shopDomain,
      destination: freshJob.storeConnection.destinationShop.shopDomain,
      failure: {
        latestErrors: failureLogs.map((log) => {
          const meta =
            log.meta && typeof log.meta === "object" && !Array.isArray(log.meta)
              ? (log.meta as Record<string, unknown>)
              : {};
          return {
            message: log.message,
            detail: typeof meta.error === "string" ? meta.error : null,
            createdAt: log.createdAt,
          };
        }),
        failedGroups: failedGroups.map((group) => ({
          stage: group.stage,
          resourceType: group.resourceType,
          count: group._count._all,
        })),
      },
    },
  };
};

function formatStage(stage: string | null) {
  if (!stage) return "unknown stage";
  return stage.replace(/_/g, " ");
}

export default function MigrationScan() {
  const { job, currentShopDomain } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const scanFetcher = useFetcher();
  const startError = searchParams.get("startError");

  const isScanning = job.status === "SCANNING";
  const isMigrationActive = job.status === "QUEUED" || job.status === "RUNNING";
  const isWaitingForStoreApproval =
    job.status === "SCANNED" &&
    (job.missingPermissions.length > 0 ||
      job.sourceNeedsReconnect ||
      job.destinationNeedsReconnect);

  const prevWaitingRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isScanning && !isMigrationActive && !isWaitingForStoreApproval) {
      return;
    }
    const interval = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(interval);
  }, [isScanning, isMigrationActive, isWaitingForStoreApproval, revalidator]);

  // Auto-run a fresh scan once the shop reconnects (prevents users being stuck)
  useEffect(() => {
    const wasWaiting = prevWaitingRef.current;
    if (wasWaiting && !isWaitingForStoreApproval) {
      // Shop was waiting for reconnect and now it's not — trigger a scan
      try {
        scanFetcher.submit(null, { method: "post", action: `/api/migrations/${job.id}/scan` });
      } catch (e) {
        // ignore — user can click Scan again manually
      }
    }
    prevWaitingRef.current = isWaitingForStoreApproval;
  }, [isWaitingForStoreApproval, job.id, scanFetcher]);

  const summary = job.scanSummary;
  const totalRecords = summary
    ? Object.values(summary.resources).reduce((sum, r) => sum + r.total, 0)
    : 0;
  const totalConflicts = summary
    ? Object.values(summary.resources).reduce(
        (sum, r) => sum + r.sampledConflicts,
        0,
      )
    : 0;
  const missingPermissions = job.missingPermissions;
  const missingPermissionScopeCount = new Set(
    missingPermissions.flatMap((permission) => permission.missing),
  ).size;
  const hasSourceMissingPermissions = missingPermissions.some(
    (permission) => permission.shopRole === "source",
  );
  const reconnectTargetShop = job.sourceNeedsReconnect ? job.source : job.destination;
  const reconnectRole = job.sourceNeedsReconnect ? "SOURCE" : "DESTINATION";
  const reconnectHref = `/auth/external/begin?shop=${encodeURIComponent(reconnectTargetShop)}&role=${reconnectRole}`;
  const reconnectStoreAppHref = `https://admin.shopify.com/store/${reconnectTargetShop.replace(/\.myshopify\.com$/i, "")}/apps/duplify-store`;
  const primaryFailure = job.failure.latestErrors[0];
  const failureReason =
    primaryFailure?.detail ??
    primaryFailure?.message ??
    "No detailed error was logged for this failure.";
  const isAuthFailure =
    /invalid api key|access token|unrecognized login|expired or was revoked|returned 401|returned 403/i.test(
      failureReason,
    );

  const isProtectedCustomerDataError = /not approved to access the Customer object|protected-customer-data|ACCESS_DENIED/i.test(
    failureReason,
  );
  const protectedCustomerDataReviewUrl =
    job.protectedCustomerDataReviewUrl ||
    "https://partners.shopify.com/192111910/apps/410803372033/customer_data";
 
  return (
    <s-page heading="Pre-migration scan" inlineSize="large">
      <s-section heading="Migration">
        <s-paragraph>
          {job.source} &rarr; {job.destination} &middot;{" "}
          <StatusBadge status={job.status} />
        </s-paragraph>
      </s-section>

      {job.status === "DRAFT" && (
        <s-section heading="Ready to scan">
          <s-paragraph>
            We'll check how many records exist, look for likely conflicts, and
            confirm your destination store has the right permissions — nothing
            is migrated yet.
          </s-paragraph>
          <Form method="post" action={`/api/migrations/${job.id}/scan`}>
            <s-button type="submit" variant="primary">
              Run scan
            </s-button>
          </Form>
        </s-section>
      )}

      {isScanning && (
        <s-section heading="Scanning store data">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner accessibilityLabel="Scanning" />
              <s-text>Reading data from {job.source}</s-text>
            </s-stack>
            <IndeterminateProgressBar label="Pre-migration scan is running" />
            <s-text color="subdued">
              Checking record counts, likely conflicts, and required
              permissions.
            </s-text>
          </s-stack>
        </s-section>
      )}

      {isMigrationActive && (
        <s-section heading="Migration is running">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner accessibilityLabel="Migration running" />
              <s-text>Copying selected data to {job.destination}</s-text>
            </s-stack>
            <IndeterminateProgressBar label="Migration is running" />
            <s-button
              href={`/app/migrations/${job.id}/progress`}
              variant="primary"
            >
              View progress
            </s-button>
          </s-stack>
        </s-section>
      )}

      {job.status === "FAILED" && (
        <s-section heading="Failure details">
          <s-stack direction="block" gap="base">
            <s-banner
              tone="critical"
              heading={
                isAuthFailure
                  ? "Store access expired — reconnect and scan again"
                  : `Failed at ${formatStage(job.currentStage)}`
              }
            >
              <s-paragraph>
                {isProtectedCustomerDataError
                  ? `This app is not approved to access customer data on Shopify. Customer exports are blocked until the app is approved for protected customer data access.`
                  : isAuthFailure
                  ? `One of the stores rejected Duplify's access token. Open Duplify once on ${job.source} (source), then come back here and run a new scan. Destination store: ${job.destination}.`
                  : failureReason}
              </s-paragraph>
              {isProtectedCustomerDataError ? (
                <>
                  <s-button
                    slot="primary-action"
                    href={reconnectHref}
                    target="_blank"
                  >
                    Approve customer access on source store
                  </s-button>
                  <s-button
                    slot="secondary-actions"
                    href={protectedCustomerDataReviewUrl}
                    target="_blank"
                  >
                    App-level API access
                  </s-button>
                  <s-button
                    slot="secondary-actions"
                    onClick={() =>
                      scanFetcher.submit(null, {
                        method: "post",
                        action: `/api/migrations/${job.id}/scan`,
                      })
                    }
                    {...(scanFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Scan again
                  </s-button>
                </>
              ) : (
                <>
                  {isAuthFailure && (
                    <s-button
                      slot="primary-action"
                      href={`https://admin.shopify.com/store/${job.source.replace(/\.myshopify\.com$/i, "")}/apps`}
                      target="_blank"
                    >
                      Open source store apps
                    </s-button>
                  )}
                  <s-button
                    slot="secondary-actions"
                    href={`/app/migrations/${job.id}/logs`}
                  >
                    View logs
                  </s-button>
                  <s-button
                    slot="secondary-actions"
                    href={`/api/migrations/${job.id}/errors.csv`}
                    target="_blank"
                  >
                    Download error report
                  </s-button>
                </>
              )}
            </s-banner>

            {job.failure.failedGroups.length > 0 && (
              <s-section heading="Failed records" padding="none">
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Stage</s-table-header>
                    <s-table-header listSlot="labeled">Resource</s-table-header>
                    <s-table-header listSlot="labeled" format="numeric">
                      Failed
                    </s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {job.failure.failedGroups.map((group) => (
                      <s-table-row key={`${group.stage}-${group.resourceType}`}>
                        <s-table-cell>{formatStage(group.stage)}</s-table-cell>
                        <s-table-cell>
                          {formatStage(group.resourceType)}
                        </s-table-cell>
                        <s-table-cell>{group.count}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-section>
            )}

            {job.failure.latestErrors.length > 0 && (
              <s-section heading="Latest errors" padding="none">
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Time</s-table-header>
                    <s-table-header listSlot="labeled">Message</s-table-header>
                    <s-table-header listSlot="labeled">Detail</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {job.failure.latestErrors.map((error) => (
                      <s-table-row key={`${error.createdAt}-${error.message}`}>
                        <s-table-cell>
                          {new Date(error.createdAt).toLocaleString()}
                        </s-table-cell>
                        <s-table-cell>{error.message}</s-table-cell>
                        <s-table-cell>{error.detail ?? "-"}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-section>
            )}
          </s-stack>
        </s-section>
      )}

      {job.status === "SCANNED" &&
        summary &&
        (job.sourceNeedsReconnect || job.destinationNeedsReconnect) && (
          <s-section heading="Reconnect store">
            <s-banner
              tone="warning"
              heading="Open Duplify on the disconnected store once"
            >
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  {job.sourceNeedsReconnect
                    ? `Source access expired for ${job.source}. Open Duplify once on that store (Allow if asked), then come back and scan again. Normal install already includes migration access — no separate "Update this store" step.`
                    : `Destination access expired for ${job.destination}. Open Duplify once on that store, then scan again.`}
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="primary"
                    href={reconnectStoreAppHref}
                    target="_blank"
                  >
                    Open store app
                  </s-button>
                  <s-button
                    variant="secondary"
                    href={reconnectHref}
                    target="_blank"
                  >
                    Reauthorize store
                  </s-button>
                  <s-button
                    variant="secondary"
                    href={protectedCustomerDataReviewUrl}
                    target="_blank"
                  >
                    Open Shopify review
                  </s-button>
                  <s-button
                    variant="secondary"
                    onClick={() =>
                      scanFetcher.submit(null, {
                        method: "post",
                        action: `/api/migrations/${job.id}/scan`,
                      })
                    }
                    {...(scanFetcher.state !== "idle" ? { loading: true } : {})}
                  >
                    Scan again
                  </s-button>
                </s-stack>
              </s-stack>
            </s-banner>
          </s-section>
        )}

      {job.status === "SCANNED" &&
        summary &&
        missingPermissions.length > 0 &&
        !job.sourceNeedsReconnect &&
        !job.destinationNeedsReconnect && (
          <s-section heading="Store access">
            <PermissionBanner
              missing={missingPermissions}
              authorizeHref={reconnectHref}
              currentShopDomain={currentShopDomain}
            />
          </s-section>
        )}

      {job.status === "SCANNED" && summary && missingPermissions.length === 0 && (
        <>
          <s-section heading="Summary">
            <s-stack direction="inline" gap="base">
              <StatCard
                label="Total records"
                value={totalRecords}
                tone="info"
              />
              <StatCard
                label="Possible conflicts"
                value={totalConflicts}
                tone={totalConflicts > 0 ? "warning" : "success"}
              />
              <StatCard
                label="Missing permissions"
                value={missingPermissionScopeCount}
                tone={missingPermissions.length > 0 ? "critical" : "success"}
              />
            </s-stack>
          </s-section>

          <s-section heading="By resource type">
            <div style={{ display: "grid", gap: "8px" }}>
              {Object.entries(summary.resources).map(([resource, result]) => (
                <div
                  key={resource}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flexWrap: "wrap",
                    padding: "12px 14px",
                    border: "1px solid #dcdfe4",
                    borderRadius: "8px",
                    background: "#ffffff",
                  }}
                >
                  <span style={{ fontWeight: 650, color: "#202223" }}>
                    {resource}
                  </span>
                  <span style={{ color: "#4a4f55" }}>
                    {result.unsupported?.length
                      ? result.unsupported[0]
                      : `${result.total} on source`}
                  </span>
                  <span
                    style={{
                      color:
                        result.sampledConflicts > 0 ? "#8a6116" : "#6d7175",
                    }}
                  >
                    {result.unsupported?.length
                      ? "Included in migration"
                      : `${result.sampledConflicts} likely conflicts ${
                          result.sampleTruncated
                            ? `(of first ${result.sampleSize})`
                            : ""
                        }`}
                  </span>
                </div>
              ))}
            </div>
          </s-section>

          {missingPermissions.length > 0 && (
            <s-section heading="Store access">
              <PermissionBanner
                missing={missingPermissions}
                authorizeHref={reconnectHref}
              />
            </s-section>
          )}

          <s-section heading="Start migration">
            {missingPermissions.length > 0 ? (
              <s-banner
                tone="warning"
                heading="Store approval required before import"
              >
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    {hasSourceMissingPermissions
                      ? "Ask the source-store admin to approve access above, then run the scan again."
                      : "Update this store's access above, then run the scan again."}{" "}
                    Import will unlock as soon as access is ready.
                  </s-paragraph>
                  <Form
                    method="post"
                    action={`/api/migrations/${job.id}/scan`}
                  >
                    <s-button type="submit" variant="secondary">
                      Run scan again
                    </s-button>
                  </Form>
                </s-stack>
              </s-banner>
            ) : (
              <s-stack direction="block" gap="base">
                {startError?.startsWith("reconnect:") && (
                  <s-banner tone="critical" heading="Store reconnect required">
                    <s-paragraph>
                      Shopify rejected access for {startError.slice("reconnect:".length)}.
                      Open Duplify on that store, then run a fresh scan.
                    </s-paragraph>
                  </s-banner>
                )}
                {job.needsPermissionRescan && (
                  <s-banner tone="warning" heading="Fresh scan required">
                    <s-paragraph>
                      Store access was updated after this scan. Run the scan
                      again before starting the migration.
                    </s-paragraph>
                  </s-banner>
                )}
                <s-paragraph>
                  Conflicting records will be handled using the conflict
                  strategy you chose. This scan is a preview based on a sample —
                  the migration itself always re-checks each record before
                  creating it, so nothing will be duplicated.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  {!job.needsPermissionRescan && (
                    <Form method="post" action={`/api/migrations/${job.id}/start`}>
                      <s-button type="submit" variant="primary">
                        Start migration
                      </s-button>
                    </Form>
                  )}
                  {job.needsPermissionRescan && (
                    <Form
                      method="post"
                      action={`/api/migrations/${job.id}/scan`}
                    >
                      <s-button type="submit" variant="secondary">
                        Run scan again
                      </s-button>
                    </Form>
                  )}
                </s-stack>
              </s-stack>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}
