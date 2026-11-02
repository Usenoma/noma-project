"use client";

import { useEffect, useRef } from "react";

/**
 * The brand film plays only for people who have not asked for reduced motion.
 * Without JS, or with reduced motion, the poster is the hero image.
 */
export function HeroFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    video.play().catch(() => {});
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
