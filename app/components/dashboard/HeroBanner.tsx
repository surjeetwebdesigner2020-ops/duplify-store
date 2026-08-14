interface HeroBannerProps {
  heading: string;
  subheading: string;
  stats: Array<{ label: string; value: number | string }>;
}

export function HeroBanner({ heading, subheading, stats }: HeroBannerProps) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #f1fbf7 0%, #f4f8ff 52%, #fff8e6 100%)",
        border: "1px solid #cfe4dc",
        borderRadius: "8px",
        padding: "18px 20px",
        marginBottom: "16px",
        color: "#202223",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "16px",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ maxWidth: "560px" }}>
          <h2 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: 700 }}>{heading}</h2>
          <p style={{ margin: 0, fontSize: "13px", color: "#6d7175", lineHeight: 1.45 }}>
            {subheading}
          </p>
        </div>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          {stats.map((stat) => (
            <div
              key={stat.label}
              style={{
                minWidth: "120px",
                padding: "10px 12px",
                border: "1px solid #d8e3f1",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.72)",
              }}
            >
              <div style={{ fontSize: "20px", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {stat.value}
              </div>
              <div style={{ fontSize: "12px", color: "#6d7175" }}>{stat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
