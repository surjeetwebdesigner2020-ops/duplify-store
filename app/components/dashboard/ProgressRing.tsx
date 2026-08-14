interface ProgressRingProps {
  percent: number; // 0-100
  size?: number;
  strokeWidth?: number;
  label?: string;
}

// Polaris web components don't ship a progress ring, so this is the one
// deliberately custom-styled piece of the dashboard (per the "premium UI"
// direction) — plain, dependency-free SVG, themed to sit naturally next to
// Polaris components.
export function ProgressRing({ percent, size = 120, strokeWidth = 10, label }: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--p-color-border-secondary, #e3e3e3)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#008060"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.4s ease" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: "22px", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(clamped)}%
        </span>
        {label && <span style={{ fontSize: "11px", color: "#6d7175" }}>{label}</span>}
      </div>
    </div>
  );
}
