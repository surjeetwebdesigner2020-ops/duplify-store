type Status =
  | "DRAFT"
  | "SCANNING"
  | "SCANNED"
  | "QUEUED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "PENDING"
  | "PROCESSING"
  | "SKIPPED"
  | "RETRYING";

const TONE: Record<
  Status,
  "neutral" | "info" | "success" | "warning" | "critical"
> = {
  DRAFT: "neutral",
  SCANNING: "info",
  SCANNED: "info",
  QUEUED: "info",
  RUNNING: "info",
  PAUSED: "warning",
  COMPLETED: "success",
  FAILED: "critical",
  CANCELLED: "neutral",
  PENDING: "neutral",
  PROCESSING: "info",
  SKIPPED: "warning",
  RETRYING: "warning",
};

const LABEL: Record<Status, string> = {
  DRAFT: "Draft",
  SCANNING: "Scan running",
  SCANNED: "Scan complete",
  QUEUED: "Queued",
  RUNNING: "Running",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  PENDING: "Pending",
  PROCESSING: "Processing",
  SKIPPED: "Skipped",
  RETRYING: "Retrying",
};

export function StatusBadge({ status }: { status: string }) {
  const key = status as Status;
  if (key === "DRAFT") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          minHeight: "18px",
          padding: 0,
          color: "#6d7175",
          fontSize: "12px",
          fontWeight: 600,
          lineHeight: "18px",
          verticalAlign: "middle",
        }}
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "999px",
            background: "#8c9196",
          }}
          aria-hidden
        />
        Draft
      </span>
    );
  }

  return (
    <s-badge tone={TONE[key] ?? "neutral"}>{LABEL[key] ?? status}</s-badge>
  );
}
