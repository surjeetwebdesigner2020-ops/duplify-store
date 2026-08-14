interface IndeterminateProgressBarProps {
  label: string;
}

export function IndeterminateProgressBar({ label }: IndeterminateProgressBarProps) {
  return (
    <div role="progressbar" aria-label={label} aria-valuetext="In progress">
      <style>
        {`
          @keyframes duplify-progress-slide {
            0% { transform: translateX(-55%); }
            100% { transform: translateX(180%); }
          }
        `}
      </style>
      <div
        style={{
          height: "8px",
          overflow: "hidden",
          borderRadius: "999px",
          background: "#e3e3e3",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            insetBlock: 0,
            inlineSize: "42%",
            borderRadius: "999px",
            background: "#008060",
            animation: "duplify-progress-slide 1.35s ease-in-out infinite",
          }}
        />
      </div>
    </div>
  );
}
