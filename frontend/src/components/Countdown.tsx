"use client";

import { useEffect, useState } from "react";
import { duration } from "@/lib/format";

// Tabular mono countdown. At zero it calls onDone once and shows doneLabel —
// it never just sits at 00:00.
export function Countdown({
  to,
  prefix,
  doneLabel = "expired",
  onDone,
}: {
  to: string;
  prefix?: string;
  doneLabel?: string;
  onDone?: () => void;
}) {
  const [remaining, setRemaining] = useState(() => new Date(to).getTime() - Date.now());

  useEffect(() => {
    const target = new Date(to).getTime();
    const tick = () => {
      const r = target - Date.now();
      setRemaining(r);
      if (r <= 0 && onDone) onDone();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);

  if (remaining <= 0) {
    return <span className="tnum font-mono text-warn">{doneLabel}</span>;
  }
  return (
    <span className="tnum font-mono text-warn">
      {prefix ? `${prefix} ` : ""}
      {duration(remaining)}
    </span>
  );
}
