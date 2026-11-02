"use client";

import { useEffect, useState } from "react";

// Thin hairline progress for the 7-day reward stream. Ticks once a minute.
export function StreamBar({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const pct =
    now === null || end <= start ? 0 : Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  const day =
    now === null
      ? null
      : Math.min(7, Math.max(1, Math.ceil(((now - start) / (end - start)) * 7)));

  return (
    <div>
      <div className="h-1 w-full bg-line">
        <div className="h-1 bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="tnum mt-1 font-mono text-[0.7rem] text-ink-dim">
        {day === null ? "streaming" : `streaming · day ${day} of 7`}
      </div>
    </div>
  );
}
