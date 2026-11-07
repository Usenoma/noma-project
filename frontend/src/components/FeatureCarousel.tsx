"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

export interface FeatureArt {
  src: string;
  title: string;
  note: string;
}

const INTERVAL_MS = 4500;

/**
 * One feature plate at a time, auto-advancing. Pauses on hover and never auto-plays for
 * people who asked for reduced motion; arrows and dots stay available.
 */
export function FeatureCarousel({ features }: { features: FeatureArt[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const go = useCallback(
    (i: number) => setIndex(((i % features.length) + features.length) % features.length),
    [features.length],
  );

  useEffect(() => {
    if (paused || features.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    timer.current = setInterval(() => setIndex((i) => (i + 1) % features.length), INTERVAL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [paused, features.length]);

  const feature = features[index];

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="flex flex-col gap-3"
    >
      <div className="relative mx-auto w-full max-w-5xl border border-line bg-bg">
        <div key={index} className="plate-slide overflow-hidden">
          <figure className="plate group">
            <div className="overflow-hidden">
              <Image
                src={feature.src}
                alt={feature.title}
                width={1280}
                height={720}
                className="h-auto w-full"
                sizes="(max-width: 1024px) 100vw, 1024px"
              />
            </div>
            <figcaption className="border-t border-line px-4 py-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-[0.6rem] tracking-[0.16em] text-accent uppercase">
                  plate {String(index + 1).padStart(2, "0")} / {String(features.length).padStart(2, "0")}
                </span>
                <span className="font-mono text-[0.6rem] tracking-[0.16em] text-ink-dim uppercase">
                  coming soon
                </span>
              </div>
              <div className="display mt-2 text-2xl">{feature.title}</div>
              <p className="mt-1 text-sm text-ink-dim">{feature.note}</p>
            </figcaption>
          </figure>
        </div>

        {features.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(index - 1)}
              aria-label="previous plate"
              className="absolute top-1/2 left-2 grid h-11 w-11 -translate-y-1/2 place-items-center border border-line bg-bg/80 font-mono text-sm text-ink-dim backdrop-blur-sm transition-colors hover:border-accent hover:text-accent"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => go(index + 1)}
              aria-label="next plate"
              className="absolute top-1/2 right-2 grid h-11 w-11 -translate-y-1/2 place-items-center border border-line bg-bg/80 font-mono text-sm text-ink-dim backdrop-blur-sm transition-colors hover:border-accent hover:text-accent"
            >
              →
            </button>
          </>
        ) : null}
      </div>

      {features.length > 1 ? (
        <div className="flex items-center justify-center gap-2">
          {features.map((f, i) => (
            <button
              key={f.title}
              type="button"
              onClick={() => go(i)}
              aria-label={`plate ${i + 1}: ${f.title}`}
              aria-current={i === index}
              className="grid h-11 w-11 place-items-center"
            >
              <span
                className={`block h-1.5 rounded-full transition-all ${
                  i === index ? "w-6 bg-accent" : "w-1.5 bg-line-strong hover:bg-ink-dim"
                }`}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
