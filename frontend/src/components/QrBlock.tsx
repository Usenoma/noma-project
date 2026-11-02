"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

// Client-side QR render — SVG, no external image service.
export function QrBlock({ value, size = 200 }: { value: string; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: "svg", margin: 1, width: size }).then((svg) => {
      if (!cancelled && ref.current) ref.current.innerHTML = svg;
    });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div
      ref={ref}
      className="inline-block border border-line bg-white p-2 [&>svg]:block"
      style={{ width: size + 18, height: size + 18 }}
      aria-label="QR code"
    />
  );
}
