import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <div className="rule-label">404</div>
        <h1 className="mt-3 text-3xl font-medium tracking-tight">not found</h1>
        <p className="mt-2 text-sm text-ink-dim">
          this page does not exist. a dead link is a dead link — no suggestions, no upsell.
        </p>
      </div>
      <Link href="/" className="font-mono text-sm text-accent hover:underline">
        ← back to noma
      </Link>
    </div>
  );
}
