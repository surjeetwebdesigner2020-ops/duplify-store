import { useState } from "react";
import { Pill } from "./Pill";

interface ExportSheetCardProps {
  label: string;
  icon: string;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  estimatedRemainingSeconds: number | null;
  isActive: boolean;
  children?: React.ReactNode;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Matrixify-style "sheet" row: one card per resource type showing exported
// count, total, and a time estimate, with an expandable detail area. Built
// as plain styled markup (no native Polaris equivalent) to match that
// reference layout while staying inside the same premium visual layer as
// ProgressRing/StageTimeline.
export function ExportSheetCard({
  label,
  icon,
  total,
  completed,
  failed,
  skipped,
  estimatedRemainingSeconds,
  isActive,
  children,
}: ExportSheetCardProps) {
  const [expanded, setExpanded] = useState(false);
  const processed = completed + failed + skipped;
  const hasChildren = Boolean(children);

  return (
    <div
      style={{
        border: "1px solid #e3e3e3",
        borderRadius: "8px",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => hasChildren && setExpanded((v) => !v)}
        style={{
          all: "unset",
          cursor: hasChildren ? "pointer" : "default",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          padding: "12px 14px",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "10px", fontWeight: 600 }}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <s-icon type={icon as any} tone="neutral" size="small"></s-icon>
          {label}
        </span>

        <span style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {completed > 0 && <Pill tone="success">Exported: {completed}</Pill>}
          {failed > 0 && <Pill tone="critical">Failed: {failed}</Pill>}
          {skipped > 0 && <Pill tone="neutral">Skipped: {skipped}</Pill>}
          <span style={{ color: "#4a4f55", fontSize: "13px", whiteSpace: "nowrap" }}>
            {processed} / {total}
          </span>
          {isActive && estimatedRemainingSeconds != null && processed < total && (
            <Pill tone="neutral">Remaining: {formatDuration(estimatedRemainingSeconds)}</Pill>
          )}
          {hasChildren && <span style={{ color: "#6d7175", fontSize: "13px" }}>{expanded ? "Hide" : "Details"}</span>}
        </span>
      </button>

      {expanded && hasChildren && (
        <div style={{ borderTop: "1px solid #e3e3e3", padding: "12px 16px", background: "#fafafa" }}>
          {children}
        </div>
      )}
    </div>
  );
}
