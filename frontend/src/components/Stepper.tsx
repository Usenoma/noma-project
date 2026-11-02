// Hairline numbered stepper for order & cycle flows.
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-0 font-mono text-xs">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center">
            {i > 0 ? <span className="mx-2 h-px w-6 bg-line" aria-hidden /> : null}
            <span
              className={`flex items-center gap-2 ${
                active ? "text-accent" : done ? "text-ink" : "text-ink-dim"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center border text-[0.65rem] ${
                  active
                    ? "border-accent text-accent"
                    : done
                      ? "border-line text-ink"
                      : "border-line text-ink-dim"
                }`}
              >
                {i + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
