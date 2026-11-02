"use client";

import { useState } from "react";
import { truncateMiddle } from "@/lib/format";

export function MonoBlock({
  value,
  truncate = false,
  label,
  className = "",
}: {
  value: string;
  truncate?: boolean;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — user selects manually
    }
  }

  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 border border-line bg-bg px-2 py-1 font-mono text-sm ${className}`}
    >
      {label ? <span className="text-[0.7rem] tracking-widest text-ink-dim uppercase">{label}</span> : null}
      <span className="tnum min-w-0 overflow-x-auto whitespace-nowrap" title={value}>
        {truncate ? truncateMiddle(value) : value}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase hover:text-accent"
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
