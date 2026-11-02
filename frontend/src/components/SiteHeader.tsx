"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FEATURES } from "@/lib/features";
import { WalletButton } from "./WalletButton";

const NAV = [
  { href: "/market", label: "Market" },
  { href: "/orders", label: "Orders" },
  { href: "/rewards", label: "Rewards" },
  { href: "/lookup", label: "Lookup" },
  { href: "/agent", label: "Agent" },
  { href: "/docs", label: "Docs" },
  // post-launch entry points (hidden while their flags are off)
  ...(FEATURES.capsules ? [{ href: "/capsules", label: "Capsules" }] : []),
  ...(FEATURES.subscriptionGuardian ? [{ href: "/subscriptions", label: "Subscriptions" }] : []),
  ...(FEATURES.ghostAgent ? [{ href: "/ghost", label: "Ghost" }] : []),
];

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (query.matches) setOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg">
      <div className="shell flex h-16 items-center gap-8">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="NOMA home">
          <span className="relative block h-8 w-8 overflow-hidden bg-black">
            <Image
              src="/brand/logo.jpg"
              alt=""
              fill
              sizes="32px"
              className="scale-[1.7] object-contain"
              priority
            />
          </span>
          <span className="wordmark text-xl leading-none transition-colors group-hover:text-accent">
            NOMA
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative py-2 font-mono text-[0.66rem] tracking-[0.16em] uppercase transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-left after:scale-x-0 after:bg-accent after:transition-transform after:duration-300 hover:text-ink hover:after:scale-x-100 ${
                  active ? "text-accent after:scale-x-100" : "text-ink-dim"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto hidden md:block">
          <WalletButton />
        </div>

        <button
          ref={triggerRef}
          type="button"
          className="ml-auto grid h-11 w-11 place-items-center rounded-full border border-line-strong text-ink transition-colors hover:border-accent hover:text-accent md:hidden"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label="Open menu"
        >
          <span className="flex flex-col gap-1.5" aria-hidden>
            <span className="block h-px w-4 bg-current" />
            <span className="block h-px w-4 bg-current" />
          </span>
        </button>
      </div>

      {open ? (
        <div
          ref={panelRef}
          id="site-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="hero-rise fixed inset-0 z-50 flex flex-col bg-bg md:hidden"
        >
          <div className="shell flex h-16 items-center justify-between border-b border-line">
            <Link
              href="/"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5"
              aria-label="NOMA home"
            >
              <span className="relative block h-8 w-8 overflow-hidden bg-black">
                <Image src="/brand/logo.jpg" alt="" fill sizes="32px" className="scale-[1.7] object-contain" />
              </span>
              <span className="wordmark text-xl leading-none">NOMA</span>
            </Link>
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="grid h-11 w-11 place-items-center rounded-full border border-line-strong text-ink transition-colors hover:border-accent hover:text-accent"
            >
              <span className="relative block h-4 w-4" aria-hidden>
                <span className="absolute left-0 top-1/2 h-px w-4 rotate-45 bg-current" />
                <span className="absolute left-0 top-1/2 h-px w-4 -rotate-45 bg-current" />
              </span>
            </button>
          </div>

          <nav className="shell flex flex-1 flex-col justify-center py-2">
            {NAV.map((item, index) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="group flex items-baseline justify-between border-b border-line py-4"
                >
                  <span className="flex items-baseline gap-4">
                    <span className="tnum font-mono text-[0.62rem] tracking-[0.16em] text-accent">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className={`display text-4xl tracking-tight transition-colors group-hover:text-accent ${
                        active ? "text-accent" : "text-ink"
                      }`}
                    >
                      {item.label}
                    </span>
                  </span>
                  <span
                    className="font-mono text-sm text-ink-dim transition-transform group-hover:translate-x-1 group-hover:text-accent"
                    aria-hidden
                  >
                    →
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-line p-5">
            <WalletButton />
            <p className="mt-4 font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
              no accounts · robinhood chain
            </p>
          </div>
        </div>
      ) : null}
    </header>
  );
}
