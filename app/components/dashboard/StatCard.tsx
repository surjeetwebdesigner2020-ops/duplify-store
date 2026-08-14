interface StatCardProps {
  label: string;
  value: number | string;
  tone?: "neutral" | "success" | "warning" | "critical" | "info";
  icon?: string;
}

const TONE_COLORS: Record<
  NonNullable<StatCardProps["tone"]>,
  { fg: string; iconTone: "neutral" | "success" | "caution" | "critical" | "info" }
> = {
  neutral: { fg: "#303030", iconTone: "neutral" },
  success: { fg: "#00543d", iconTone: "success" },
  warning: { fg: "#8a6116", iconTone: "caution" },
  critical: { fg: "#8e1f0b", iconTone: "critical" },
  info: { fg: "#00437a", iconTone: "info" },
};

export function StatCard({ label, value, tone = "neutral", icon }: StatCardProps) {
  const c = TONE_COLORS[tone];
  return (
    <s-box padding="base" border="base" borderRadius="base" background="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {icon && (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <s-icon type={icon as any} tone={c.iconTone} size="small"></s-icon>
          )}
          <s-text color="subdued">{label}</s-text>
        </s-stack>
        <span
          style={{
            fontSize: "28px",
            fontWeight: 700,
            lineHeight: 1.1,
            color: c.fg,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
      </s-stack>
    </s-box>
  );
}
