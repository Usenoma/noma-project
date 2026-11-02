import { truncateMiddle } from "@/lib/format";

// Links to the chain explorer. Explorer base is configurable; Robinhood Chain
// explorer URL goes here once known.
const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "";

export function TxLink({ hash, confirmations }: { hash: string; confirmations?: number }) {
  const label = truncateMiddle(hash, 10, 8);
  const inner = (
    <span className="tnum font-mono text-sm text-accent hover:underline">{label} ↗</span>
  );
  return (
    <span className="inline-flex items-center gap-2">
      {EXPLORER ? (
        <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
          {inner}
        </a>
      ) : (
        <span className="tnum font-mono text-sm">{label}</span>
      )}
      {confirmations != null ? (
        <span className="font-mono text-[0.7rem] text-ink-dim">{confirmations} conf</span>
      ) : null}
    </span>
  );
}
