export function Stat({
  label,
  value,
  caption,
  tone = "default",
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: "default" | "accent" | "warn" | "good" | "bad";
}) {
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "warn"
        ? "text-warn"
        : tone === "good"
          ? "text-good"
          : tone === "bad"
            ? "text-bad"
            : "text-ink";
  return (
    <div className="bg-bg px-4 py-4">
      <div className="font-mono text-[0.65rem] tracking-[0.16em] text-ink-dim uppercase">
        {label}
      </div>
      <div className={`tnum mt-2 text-2xl font-medium tracking-tight sm:text-3xl ${toneClass}`}>
        {value}
      </div>
      {caption ? <div className="mt-1 font-mono text-[0.65rem] text-ink-dim">{caption}</div> : null}
    </div>
  );
}
