"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <div className="rule-label">error</div>
        <h1 className="mt-3 text-3xl font-medium tracking-tight">something failed</h1>
        <p className="mt-2 text-sm text-ink-dim">
          the page could not render. this is on our side — try again, or go back to the market.
        </p>
        {error.digest ? (
          <p className="tnum mt-2 font-mono text-xs text-ink-dim">digest {error.digest}</p>
        ) : null}
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="border border-line px-4 py-2 font-mono text-sm tracking-widest uppercase hover:border-accent hover:text-accent"
        >
          try again
        </button>
        <a
          href="/market"
          className="border border-line px-4 py-2 font-mono text-sm tracking-widest text-ink-dim uppercase hover:border-accent hover:text-accent"
        >
          the market
        </a>
      </div>
    </div>
  );
}
