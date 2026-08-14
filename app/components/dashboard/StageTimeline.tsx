interface StageTimelineProps {
  stages: string[];
  currentStage: string | null;
  status: string;
}

const STAGE_LABELS: Record<string, string> = {
  files: "Files",
  metafield_definitions: "Metafield definitions",
  metaobject_definitions: "Metaobject definitions",
  products: "Products & variants",
  images: "Product images",
  inventory: "Inventory",
  collections: "Collections",
  customers: "Customers",
  pages: "Pages",
  blogs: "Blogs & articles",
  menus: "Menus",
  metaobjects: "Metaobject entries",
  discounts: "Discounts",
  orders: "Orders",
  theme: "Theme",
};

// Plain flex-wrap markup (rather than s-stack) since a Full/Custom migration
// can have 15 stages — this needs to wrap across lines cleanly, which native
// Polaris Stack doesn't expose a wrap option for.
export function StageTimeline({ stages, currentStage, status }: StageTimelineProps) {
  const currentIndex = currentStage ? stages.indexOf(currentStage) : -1;
  const isDone = status === "COMPLETED";

  return (
    <div style={{ display: "flex", flexWrap: "wrap", rowGap: "10px", columnGap: "4px" }}>
      {stages.map((stage, index) => {
        const done = isDone || index < currentIndex;
        const active = !isDone && index === currentIndex;
        const color = done ? "#008060" : active ? "#1f5199" : "#c9cccf";

        return (
          <div key={stage} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: color,
                display: "inline-block",
                flexShrink: 0,
                boxShadow: active ? "0 0 0 4px rgba(31,81,153,0.15)" : "none",
              }}
            />
            <span style={{ fontSize: "13px", color: done || active ? "#202223" : "#8a8a8a", whiteSpace: "nowrap" }}>
              {STAGE_LABELS[stage] ?? stage}
            </span>
            {index < stages.length - 1 && (
              <span style={{ width: 20, height: 1, background: "#c9cccf", margin: "0 4px" }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
