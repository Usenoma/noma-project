"use client";

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div>
      {label ? (
        <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          {label}
        </div>
      ) : null}
      <div className="inline-flex border border-line" role="radiogroup" aria-label={label}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={String(opt.value)}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
              className={`tnum border-r border-line px-4 py-2 font-mono text-sm transition-colors duration-150 last:border-r-0 ${
                active
                  ? "bg-bg-raised text-accent shadow-[inset_0_-2px_0_0_var(--accent)]"
                  : "text-ink-dim hover:text-ink"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
