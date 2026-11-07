import Link from "next/link";

export function EmptyState({
  line,
  action,
}: {
  line: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="border-t border-line py-10">
      <p className="max-w-xl text-lg text-ink-dim">{line}</p>
      {action ? (
        <Link
          href={action.href}
          className="mt-4 inline-flex min-h-11 items-center gap-2 font-mono text-sm text-accent hover:underline"
        >
          {action.label} →
        </Link>
      ) : null}
    </div>
  );
}
