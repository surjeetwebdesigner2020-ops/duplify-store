export interface MappingRow {
  id: string;
  resourceType: string;
  sourceId: string;
  destinationId: string;
  sourceHandle: string | null;
  destinationHandle: string | null;
  updatedAt: string;
}

export function MappingsTable({ rows }: { rows: MappingRow[] }) {
  if (rows.length === 0) {
    return <s-paragraph>No ID mappings match your filters yet.</s-paragraph>;
  }

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {rows.map((row) => (
        <div
          key={row.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            flexWrap: "wrap",
            padding: "12px 14px",
            border: "1px solid #dcdfe4",
            borderRadius: "8px",
            background: "#ffffff",
          }}
        >
          <s-badge tone="info">{row.resourceType}</s-badge>
          <span style={{ flex: "1 1 220px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.sourceHandle ?? row.sourceId}
          </span>
          <span style={{ color: "#6d7175" }}>&rarr;</span>
          <span style={{ flex: "1 1 220px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.destinationHandle ?? row.destinationId}
          </span>
          <span style={{ marginLeft: "auto", color: "#6d7175", fontSize: "13px", whiteSpace: "nowrap" }}>
            {new Date(row.updatedAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
