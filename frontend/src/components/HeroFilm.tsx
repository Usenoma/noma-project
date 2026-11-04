"use client";

import { useEffect, useRef } from "react";

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * The brand film plays only when the visitor allows motion and is not on a slow or
 * data-saving connection. Otherwise the poster stays as the hero image.
 */
export function HeroFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (connection?.saveData) return;
    if (connection?.effectiveType && /(^|-)2g$|slow-2g/.test(connection.effectiveType)) return;

    // start the download only after the page is interactive; the poster covers the gap
    const start = () => {
      video.play().catch(() => {});
    };
    const idle = window.requestIdleCallback?.bind(window);
    if (idle) {
      const handle = idle(start, { timeout: 1200 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(start, 300);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <video
      ref={ref}
      className="absolute inset-0 h-full w-full object-cover"
      poster="/brand/private-commerce.jpg?v=2"
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
    >
      <source src="/brand/hero.mp4?v=2" type="video/mp4" />
    </video>
  );
}
