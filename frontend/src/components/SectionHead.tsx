import type { ReactNode } from "react";
import Link from "next/link";

export function SectionHead({
  num,
  title,
  lead,
  link,
}: {
  num: string;
  title: ReactNode;
  lead?: string;
  link?: { href: string; label: string };
}) {
  return (
    <div className="mb-10 border-t border-line-strong pt-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="font-mono text-[0.68rem] tracking-[0.16em] text-accent uppercase">
          §{num}
        </span>
        {link ? (
          <Link
            href={link.href}
            className="ml-auto font-mono text-[0.66rem] tracking-[0.16em] text-ink-dim uppercase transition-colors hover:text-accent"
          >
            {link.label} →
          </Link>
        ) : null}
      </div>
      <h2 className="mt-4 max-w-4xl text-4xl leading-[1.02] tracking-[-0.045em] sm:text-5xl lg:text-6xl xl:text-7xl">
        {title}
      </h2>
      {lead ? <p className="mt-4 max-w-2xl text-base text-ink-dim">{lead}</p> : null}
    </div>
  );
}
