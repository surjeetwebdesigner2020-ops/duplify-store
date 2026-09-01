import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { migrationJobForOwnerWhere } from "../lib/services/storeConnection.service";
import { StatCard } from "../components/dashboard/StatCard";
import { StatusBadge } from "../components/dashboard/StatusBadge";
import { ProgressRing } from "../components/dashboard/ProgressRing";
import { StageTimeline } from "../components/dashboard/StageTimeline";
import { ExportSheetCard } from "../components/dashboard/ExportSheetCard";
import { PermissionBanner } from "../components/dashboard/PermissionBanner";
import { ProtectedCustomerDataBanner } from "../components/dashboard/ProtectedCustomerDataBanner";
import { Pill } from "../components/dashboard/Pill";
import { IndeterminateProgressBar } from "../components/dashboard/IndeterminateProgressBar";
import { ConfirmDestructiveModal } from "../components/shared/ConfirmDestructiveModal";
import { stagesForJob } from "../lib/services/orchestrator.service";
import type { ScanSummary } from "../lib/services/scan.service";
import {
  liveMissingAppPermissions,
  needsPermissionRescan,
  storeScopesFromConnection,
} from "../lib/services/permissionStatus.server";

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING", "SCANNING"]);

// Maps each "sheet" shown on this page to the MigrationItem.resourceType rows
// that feed it, and which selectedResources entry has to be present for the
// job to include it at all.
const SHEET_DEFS = [
  { resourceType: "file", label: "Files", icon: "file", requires: "files" },
  {
    resourceType: "metafield_definition",
    label: "Metafield definitions",
    icon: "database-add",
    requires: "metafield_definitions",
  },
  {
    resourceType: "metaobject_definition",
    label: "Metaobject definitions",
    icon: "database",
    requires: "metaobject_definitions",
  },
  {
    resourceType: "product",
    label: "Products",
    icon: "product",
    requires: "products",
  },
  {
    resourceType: "variant",
    label: "Variants",
    icon: "variant",
    requires: "products",
  },
  {
    resourceType: "image",
    label: "Product images",
    icon: "image",
    requires: "images",
  },
  {
    resourceType: "inventory",
    label: "Inventory",
    icon: "package",
    requires: "inventory",
  },
  {
    resourceType: "collection",
    label: "Collections",
    icon: "collection",
    requires: "collections",
  },
  {
    resourceType: "customer",
    label: "Customers",
    icon: "person",
    requires: "customers",
  },
  {
    resourceType: "page",
    label: "Pages",
    icon: "page-list",
    requires: "pages",
  },
  { resourceType: "blog", label: "Blogs", icon: "blog", requires: "blogs" },
  {
    resourceType: "article",
    label: "Articles",
    icon: "page-attachment",
    requires: "blogs",
  },
  { resourceType: "menu", label: "Menus", icon: "menu", requires: "menus" },
  {
    resourceType: "metaobject",
    label: "Metaobject entries",
    icon: "database-connect",
    requires: "metaobjects",
  },
  {
    resourceType: "discount",
    label: "Discounts",
    icon: "discount",
    requires: "discounts",
  },
  {
    resourceType: "order",
    label: "Orders (draft)",
    icon: "order-draft",
    requires: "orders",
  },
  {
    resourceType: "theme",
    label: "Theme files",
    icon: "theme",
    requires: "theme",
  },
] as const;

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

  const stages = stagesForJob(job.selectedResources as string[]);
  const selectedResources = job.selectedResources as string[];
  const scanSummary = job.scanSummary as ScanSummary | null;

  const grouped = await db.migrationItem.groupBy({
    by: ["resourceType", "status"],
    where: { migrationJobId: job.id },
    _count: { _all: true },
  });

  const countsByResource = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const entry = countsByResource.get(row.resourceType) ?? {};
    entry[row.status] = row._count._all;
    countsByResource.set(row.resourceType, entry);
  }

  let estimatedRemainingSeconds: number | null = null;
  if (
    job.startedAt &&
    job.completedRecords > 0 &&
    job.totalRecords > job.completedRecords
  ) {
    const elapsedSeconds = (Date.now() - job.startedAt.getTime()) / 1000;
    const rate = job.completedRecords / elapsedSeconds;
    estimatedRemainingSeconds =
      rate > 0
        ? Math.round((job.totalRecords - job.completedRecords) / rate)
        : null;
  }

  const sheets = SHEET_DEFS.filter((def) =>
    selectedResources.includes(def.requires),
  ).map((def) => {
    const counts = countsByResource.get(def.resourceType) ?? {};
    const completed = counts.COMPLETED ?? 0;
    const failed = counts.FAILED ?? 0;
    const skipped = counts.SKIPPED ?? 0;
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return { ...def, total, completed, failed, skipped };
  });

  const skippedDefinitionRecords = sheets
    .filter(
      (s) =>
        s.resourceType === "metafield_definition" ||
        s.resourceType === "metaobject_definition",
    )
    .reduce((sum, s) => sum + s.skipped, 0);

  const storeScopes = storeScopesFromConnection(job.storeConnection);
  const missingPermissions = liveMissingAppPermissions(storeScopes);
  const protectedCustomerDataBlocked =
    selectedResources.includes("customers") &&
    Boolean(
      await db.migrationLog.findFirst({
        where: {
          migrationJobId: job.id,
          OR: [
            { message: { contains: "not approved to access the Customer object", mode: "insensitive" } },
            { message: { contains: "protected-customer-data", mode: "insensitive" } },
          ],
        },
        select: { id: true },
      }),
    );

  return {
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      currentStage: job.currentStage,
      totalRecords: job.totalRecords,
      completedRecords: job.completedRecords,
      failedRecords: job.failedRecords,
      skippedRecords: job.skippedRecords,
      skippedDefinitionRecords,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      source: job.storeConnection.sourceShop.shopDomain,
      destination: job.storeConnection.destinationShop.shopDomain,
      stages,
      scanGeneratedAt: scanSummary?.generatedAt ?? null,
      needsPermissionRescan: needsPermissionRescan(
        scanSummary,
        selectedResources,
        storeScopes,
      ),
      estimatedRemainingSeconds,
      sheets,
      missingPermissions,
      protectedCustomerDataBlocked,
    },
  };
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function MigrationProgress() {
  const { job } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const isActive = ACTIVE_STATUSES.has(job.status);
  const isScanning = job.status === "SCANNING";
  const isScanComplete = job.status === "SCANNED";
  const hasMissingPermissions = job.missingPermissions.length > 0;
  const canStartMigration = isScanComplete && !hasMissingPermissions;
  const sourceReconnectHref = `/auth/external/begin?shop=${encodeURIComponent(job.source)}&role=SOURCE`;
  const retryableCount = job.failedRecords + (job.skippedDefinitionRecords ?? 0);
  const retryLabel =
    job.failedRecords > 0 && (job.skippedDefinitionRecords ?? 0) > 0
      ? `Retry ${job.failedRecords} failed + ${job.skippedDefinitionRecords} skipped definition(s)`
      : job.failedRecords > 0
        ? `Retry ${job.failedRecords} failed record(s)`
        : `Retry ${job.skippedDefinitionRecords} skipped definition(s)`;

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(interval);
  }, [isActive, revalidator]);

  const percent =
    job.totalRecords > 0 ? (job.completedRecords / job.totalRecords) * 100 : 0;
  const ringPercent = isScanComplete ? 100 : percent;
  const ringLabel = isScanning
    ? "SCANNING"
    : isScanComplete
      ? "SCAN DONE"
      : (job.currentStage ?? job.status);
  const processedRecords =
    job.completedRecords + job.failedRecords + job.skippedRecords;
  const statusDetail = isScanning
    ? "Scan is checking store data and permissions."
    : isScanComplete
      ? hasMissingPermissions
        ? "Scan finished, but permissions need attention before migration can start."
        : job.needsPermissionRescan
          ? "Scan finished. Access was updated after this scan — you can start now or refresh counts."
          : "Scan finished. Migration has not started yet."
      : `${processedRecords} of ${job.totalRecords} processed`;

  return (
    <s-page heading="Migration progress" inlineSize="large">
      {job.protectedCustomerDataBlocked && (
        <s-section>
          <ProtectedCustomerDataBanner tone="critical" sourceShop={job.source} />
        </s-section>
      )}
      {job.missingPermissions.length > 0 && (
        <s-section>
          <PermissionBanner
            missing={job.missingPermissions}
            authorizeHref={sourceReconnectHref}
          />
        </s-section>
      )}

      {isScanning && (
        <s-section heading="Scan running">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-spinner accessibilityLabel="Scan running" />
              <s-text>
                Checking records, conflicts, and Shopify permissions.
              </s-text>
            </s-stack>
            <IndeterminateProgressBar label="Pre-migration scan is running" />
          </s-stack>
        </s-section>
      )}

      {isScanComplete && (
        <s-section heading="Scan result">
          <s-stack direction="block" gap="base">
            <s-banner
              tone={hasMissingPermissions ? "warning" : "success"}
              heading={
                hasMissingPermissions
                  ? "Scan complete: permissions needed"
                  : "Scan complete"
              }
            >
              <s-paragraph>{statusDetail}</s-paragraph>
            </s-banner>
            <s-button-group>
              <s-button
                href={`/app/migrations/${job.id}/scan`}
                variant="secondary"
              >
                Review scan details
              </s-button>
              {canStartMigration && (
                <Form method="post" action={`/api/migrations/${job.id}/start`}>
                  <s-button type="submit" variant="primary">
                    Start migration
                  </s-button>
                </Form>
              )}
              {job.needsPermissionRescan && !hasMissingPermissions && (
                <Form method="post" action={`/api/migrations/${job.id}/scan`}>
                  <s-button type="submit" variant="secondary">
                    Run scan again
                  </s-button>
                </Form>
              )}
            </s-button-group>
          </s-stack>
        </s-section>
      )}

      <s-section heading={`${job.source} → ${job.destination}`}>
        <s-grid gridTemplateColumns="140px 1fr" gap="base">
          <s-box padding="base">
            <ProgressRing percent={ringPercent} label={ringLabel} />
          </s-box>

          <s-stack direction="block" gap="base">
            <s-grid
              gridTemplateColumns="repeat(4, minmax(140px, 1fr))"
              gap="base"
            >
              <StatCard label="Total records" value={job.totalRecords} />
              <StatCard
                label="Completed"
                value={job.completedRecords}
                tone="success"
              />
              <StatCard
                label="Failed"
                value={job.failedRecords}
                tone={job.failedRecords > 0 ? "critical" : "neutral"}
              />
              <StatCard
                label="Skipped"
                value={job.skippedRecords}
                tone="warning"
              />
            </s-grid>

            <s-box padding="small" background="subdued" borderRadius="base">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text>Status</s-text>
                <StatusBadge status={job.status} />
                <s-text color="subdued">{statusDetail}</s-text>
                {job.startedAt && (
                  <s-text color="subdued">
                    Started {new Date(job.startedAt).toLocaleString()}
                  </s-text>
                )}
                {isActive && job.estimatedRemainingSeconds != null && (
                  <s-text color="subdued">
                    ~{formatDuration(job.estimatedRemainingSeconds)} remaining
                  </s-text>
                )}
              </s-stack>
            </s-box>
          </s-stack>
        </s-grid>
      </s-section>

      <s-section heading="Stages">
        <StageTimeline
          stages={job.stages}
          currentStage={job.currentStage}
          status={job.status}
        />
      </s-section>

      <s-section heading="Sheets">
        <s-stack direction="block" gap="small-300">
          {job.sheets.map((sheet) => (
            <ExportSheetCard
              key={sheet.resourceType}
              label={sheet.label}
              icon={sheet.icon}
              total={sheet.total}
              completed={sheet.completed}
              failed={sheet.failed}
              skipped={sheet.skipped}
              estimatedRemainingSeconds={job.estimatedRemainingSeconds}
              isActive={isActive}
            >
              {sheet.failed > 0 && (
                <s-paragraph>
                  {sheet.failed} {sheet.label.toLowerCase()} failed —{" "}
                  <s-link href={`/app/migrations/${job.id}/logs`}>
                    view logs
                  </s-link>{" "}
                  or download the{" "}
                  <s-link
                    href={`/api/migrations/${job.id}/errors/csv`}
                    target="_blank"
                  >
                    error report
                  </s-link>
                  .
                </s-paragraph>
              )}
            </ExportSheetCard>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Details">
        <s-stack direction="inline" gap="small-300">
          <Pill tone="neutral">ID: {job.id.slice(-8)}</Pill>
          <Pill tone="info">State: {job.status}</Pill>
          <Pill tone="neutral">Type: {job.type}</Pill>
          {job.startedAt && (
            <Pill tone="neutral">
              Started: {new Date(job.startedAt).toLocaleString()}
            </Pill>
          )}
          {job.completedAt && (
            <Pill tone="neutral">
              Completed: {new Date(job.completedAt).toLocaleString()}
            </Pill>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Actions">
        <s-button-group>
          {retryableCount > 0 && (
            <Form
              method="post"
              action={`/api/migrations/${job.id}/retry`}
              id="retry-form"
            >
              <s-button slot="primary-action" type="submit" variant="primary">
                {retryLabel}
              </s-button>
            </Form>
          )}

          {isActive && (
            <ConfirmDestructiveModal
              id="cancel-migration-modal"
              heading="Cancel this migration?"
              message="Records already completed will stay on the destination store. Anything still pending will stop being processed."
              confirmLabel="Cancel migration"
              triggerLabel="Cancel migration"
              formAction={`/api/migrations/${job.id}/cancel`}
            />
          )}

          {job.failedRecords > 0 && (
            <s-button
              slot="secondary-actions"
              href={`/api/migrations/${job.id}/errors/csv`}
              target="_blank"
            >
              Download error report (CSV)
            </s-button>
          )}
          <s-button
            slot="secondary-actions"
            href={`/app/migrations/${job.id}/logs`}
          >
            View logs
          </s-button>
        </s-button-group>
      </s-section>
    </s-page>
  );
}
