import type { ReactNode } from "react";

export function FigureBox({
  caption,
  children,
  className = "",
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`border border-line bg-bg ${className}`}>
      <figcaption className="border-b border-line px-4 py-2.5 font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
        {caption}
      </figcaption>
      <div className="p-5 sm:p-6">{children}</div>
    </figure>
  );
}
