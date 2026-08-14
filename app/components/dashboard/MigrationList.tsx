import { useFetcher, useLocation } from "react-router";
import { IndeterminateProgressBar } from "./IndeterminateProgressBar";
import { StatusBadge } from "./StatusBadge";

interface MigrationListJob {
  id: string;
  type: string;
  status: string;
  source: string;
  destination: string;
  totalRecords: number;
  completedRecords: number;
  failedRecords?: number;
  missingPermissionsCount?: number;
  /** True when scan finished with 0 because access/reconnect blocked counting */
  scanBlocked?: boolean;
  createdAt: Date | string;
}

interface MigrationListProps {
  jobs: MigrationListJob[];
  showFailed?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  FULL: "Full store",
  PRODUCTS: "Products",
  COLLECTIONS: "Collections",
  CUSTOMERS: "Customers",
  CONTENT: "Content",
  THEME: "Theme",
  CUSTOM: "Custom",
};

function formatType(type: string) {
  return TYPE_LABELS[type] ?? type;
}

function formatStartedAt(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getProgressPercent(completedRecords: number, totalRecords: number) {
  if (totalRecords <= 0) return 0;
  return Math.min(100, Math.round((completedRecords / totalRecords) * 100));
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getProgressState(job: MigrationListJob) {
  const missingPermissionsCount = job.missingPermissionsCount ?? 0;
  const progressPercent = getProgressPercent(
    job.completedRecords,
    job.totalRecords,
  );

  if (job.status === "SCANNING") {
    return {
      label: "Scan status",
      value: "Scanning stores",
      percent: 0,
      indeterminate: true,
      color: "#008060",
      ariaLabel: "Pre-migration scan is running",
    };
  }

  if (job.status === "SCANNED") {
    const missingPermissionsCount = job.missingPermissionsCount ?? 0;
    let value: string;
    let color = "#008060";
    if (job.scanBlocked || missingPermissionsCount > 0) {
      value = job.scanBlocked
        ? "Reconnect source store"
        : `${pluralize(missingPermissionsCount, "permission")} missing`;
      color = "#b7791f";
    } else if (job.totalRecords > 0) {
      value = `${pluralize(job.totalRecords, "record")} found`;
    } else {
      value = "No records found";
    }
    return {
      label: "Scan complete",
      value,
      percent: 100,
      indeterminate: false,
      color,
      ariaLabel: "Pre-migration scan completed",
    };
  }

  if (job.status === "DRAFT") {
    return {
      label: "Scan status",
      value: "Not scanned",
      percent: 0,
      indeterminate: false,
      color: "#c9cccf",
      ariaLabel: "Pre-migration scan not started",
    };
  }

  if (
    job.status === "QUEUED" ||
    (job.status === "RUNNING" && job.totalRecords <= 0)
  ) {
    return {
      label: "Migration status",
      value: job.status === "QUEUED" ? "Queued" : "Running",
      percent: 0,
      indeterminate: true,
      color: "#008060",
      ariaLabel: "Migration is running",
    };
  }

  return {
    label: "Migration progress",
    value:
      job.totalRecords > 0
        ? `${job.completedRecords} / ${job.totalRecords}`
        : "Not started",
    percent: progressPercent,
    indeterminate: false,
    color: job.totalRecords > 0 ? "#008060" : "#c9cccf",
    ariaLabel: `Migration progress ${progressPercent}%`,
  };
}

function getStatusAccent(status: string) {
  if (status === "COMPLETED") return { border: "#008060", bg: "#f7fffb" };
  if (status === "FAILED") return { border: "#d72c0d", bg: "#fff8f7" };
  if (status === "RUNNING" || status === "QUEUED" || status === "SCANNING") {
    return { border: "#2c6ecb", bg: "#f7fbff" };
  }
  if (status === "PAUSED" || status === "RETRYING" || status === "SKIPPED") {
    return { border: "#b7791f", bg: "#fffaf0" };
  }
  return { border: "#c9cccf", bg: "#ffffff" };
}

function isActiveStatus(status: string) {
  return status === "SCANNING" || status === "QUEUED" || status === "RUNNING";
}

export function MigrationList({
  jobs,
  showFailed = false,
}: MigrationListProps) {
  const location = useLocation();
  const deleteFetcher = useFetcher();
  const isDeleting = deleteFetcher.state !== "idle";

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {jobs.map((job) => {
        const progress = getProgressState(job);
        const missingPermissionsCount = job.missingPermissionsCount ?? 0;
        const scanNeedsPermissions =
          job.status === "SCANNED" && missingPermissionsCount > 0;
        const accent = scanNeedsPermissions
          ? { border: "#b7791f", bg: "#fffaf0" }
          : getStatusAccent(job.status);
        const deleteDisabled = isActiveStatus(job.status);
        const viewLabel =
          job.status === "SCANNED"
            ? "Review scan"
            : job.status === "SCANNING"
              ? "View scan"
              : "View";
        const viewHref =
          job.status === "DRAFT" ||
          job.status === "SCANNING" ||
          job.status === "SCANNED"
            ? `/app/migrations/${job.id}/scan`
            : `/app/migrations/${job.id}/progress`;

        return (
          <div
            key={job.id}
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "16px",
              alignItems: "center",
              padding: "12px 14px",
              border: "1px solid #dcdfe4",
              borderLeft: `4px solid ${accent.border}`,
              borderRadius: "8px",
              background: accent.bg,
            }}
          >
            <div style={{ flex: "2 1 300px", minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 650, color: "#202223" }}>
                  {formatType(job.type)}
                </span>
                <StatusBadge status={job.status} />
                {job.status === "SCANNING" && (
                  <s-spinner accessibilityLabel="Scan running" />
                )}
                {scanNeedsPermissions && (
                  <s-badge tone="warning">Needs permissions</s-badge>
                )}
                {showFailed && (job.failedRecords ?? 0) > 0 && (
                  <s-badge tone="critical">{job.failedRecords} failed</s-badge>
                )}
              </div>
              <div
                style={{
                  marginTop: "5px",
                  color: "#4a4f55",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "13px",
                }}
                title={`${job.source} -> ${job.destination}`}
              >
                {job.source} &rarr; {job.destination}
              </div>
            </div>

            <div style={{ flex: "1 1 220px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  marginBottom: "6px",
                  color: "#4a4f55",
                  fontSize: "13px",
                }}
              >
                <span>{progress.label}</span>
                <span>{progress.value}</span>
              </div>
              {progress.indeterminate ? (
                <IndeterminateProgressBar label={progress.ariaLabel} />
              ) : (
                <div
                  aria-label={progress.ariaLabel}
                  style={{
                    height: "8px",
                    overflow: "hidden",
                    borderRadius: "999px",
                    background: "#ebedf0",
                  }}
                >
                  <div
                    style={{
                      width: `${progress.percent}%`,
                      height: "100%",
                      borderRadius: "999px",
                      background: progress.color,
                    }}
                  />
                </div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: "12px",
                flexWrap: "wrap",
                flex: "1 1 190px",
                marginLeft: "auto",
              }}
            >
              <span
                style={{
                  color: "#4a4f55",
                  fontSize: "13px",
                  whiteSpace: "nowrap",
                }}
              >
                {formatStartedAt(job.createdAt)}
              </span>
              <s-button href={viewHref} variant="primary">
                {viewLabel}
              </s-button>
              <s-button
                command="--show"
                commandFor={`delete-migration-modal-${job.id}`}
                icon="delete"
                variant="tertiary"
                tone="critical"
                disabled={deleteDisabled || isDeleting}
                accessibilityLabel={`Delete migration ${formatType(job.type)} from ${formatStartedAt(job.createdAt)}`}
              ></s-button>
              <s-modal
                id={`delete-migration-modal-${job.id}`}
                heading="Delete migration?"
              >
                <s-stack direction="block" gap="base">
                  <s-text>
                    This removes the migration job, its logs, item statuses, and
                    conflict records from Duplify Store.
                  </s-text>
                  <s-banner tone="warning">
                    <s-text>
                      Migrated records already created in Shopify will stay
                      there.
                    </s-text>
                  </s-banner>
                </s-stack>
                <s-button
                  slot="primary-action"
                  variant="primary"
                  tone="critical"
                  loading={isDeleting}
                  command="--hide"
                  commandFor={`delete-migration-modal-${job.id}`}
                  onClick={() => {
                    deleteFetcher.submit(
                      { returnTo: `${location.pathname}${location.search}` },
                      {
                        method: "post",
                        action: `/api/migrations/${job.id}/delete`,
                      },
                    );
                  }}
                >
                  Delete migration
                </s-button>
                <s-button
                  slot="secondary-actions"
                  variant="secondary"
                  command="--hide"
                  commandFor={`delete-migration-modal-${job.id}`}
                >
                  Cancel
                </s-button>
              </s-modal>
            </div>
          </div>
        );
      })}
    </div>
  );
}
