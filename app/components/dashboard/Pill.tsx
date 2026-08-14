const COLORS: Record<string, { bg: string; fg: string }> = {
  success: { bg: "#d1f7e0", fg: "#00543d" },
  critical: { bg: "#fde3e0", fg: "#8e1f0b" },
  info: { bg: "#e0edff", fg: "#00437a" },
  neutral: { bg: "#f1f1f1", fg: "#444" },
};

export function Pill({
  tone,
  children,
}: {
  tone: "success" | "critical" | "info" | "neutral";
  children: React.ReactNode;
}) {
  const c = COLORS[tone];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        borderRadius: "999px",
        padding: "3px 10px",
        fontSize: "12px",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
