const ITEMS = ["eSIM", "AI credits", "VPS", "Gift cards"];

export function Marquee() {
  return (
    <div
      className="marquee marquee-mask border-b border-line py-4"
      aria-hidden="true"
    >
      <div className="marquee-track">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 items-center gap-10 pr-10">
            {ITEMS.map((item) => (
              <span key={item} className="flex items-center gap-10">
                <span className="display text-xl uppercase tracking-[0.14em] text-ink-dim sm:text-2xl">
                  {item}
                </span>
                <span className="text-sm text-accent">·</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
