import Image from "next/image";
import Link from "next/link";
import { HeroFilm } from "@/components/HeroFilm";
import { Marquee } from "@/components/Marquee";
import { SectionHead } from "@/components/SectionHead";
import { FigureBox } from "@/components/FigureBox";
import { RewardsCard } from "@/components/RewardsCard";
import { CategoryIndex } from "@/components/CategoryIndex";
import { FeatureCarousel } from "@/components/FeatureCarousel";

const FEATURE_ART = [
  {
    src: "/brand/ghost-checkout.jpg",
    title: "Ghost Checkout",
    note: "one checkout, a different identity for every provider",
  },
  {
    src: "/brand/capsules.jpg",
    title: "Digital Capsules",
    note: "buy the outcome, not the checklist",
  },
  {
    src: "/brand/exposure-receipt.jpg",
    title: "Exposure Receipt",
    note: "see exactly what leaves your side before you pay",
  },
  {
    src: "/brand/subscription-guardian.jpg",
    title: "Subscription Guardian",
    note: "the agent watches the renewals you forget",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Choose",
    body: "The product page lists exactly what you provide and what you receive, before you pay anything.",
  },
  {
    n: "02",
    title: "Pay",
    body: "The invoice locks the price for 15 minutes. Send USDG or ETH on Robinhood Chain to the fixed address, in the exact amount.",
  },
  {
    n: "03",
    title: "Receive",
    body: "Payment is confirmed on-chain, the supplier is called, and the deliverable is stored encrypted. Only the order key opens it.",
  },
  {
    n: "04",
    title: "Prove",
    body: "Optional. Attach the order to a wallet and it appears in your order index. Otherwise the order key is the only credential.",
  },
];

const CYCLE = [
  ["trades", "every $NOMA buy/sell on Pons"],
  ["1% creator tax", "quote asset, never $NOMA"],
  ["fee escrow", "claimed by the Reward Engine Safe"],
  ["50 / 50", "ZEC · stock of the week"],
  ["notifyReward", "streamed to stakers over 7 days"],
];

export default function Home() {
  return (
    <div>
      {/* Masthead — a full-bleed stage, the brand film behind the type. */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="absolute inset-0 bg-black" />
        <HeroFilm />
        <div className="hero-scrim absolute inset-0" aria-hidden />

        <div className="shell relative flex min-h-[82svh] flex-col justify-end pb-10 pt-24 lg:min-h-[88svh] lg:pb-14">
          <div className="grid gap-10 lg:grid-cols-[1fr_320px] lg:items-end">
            <div>
              <div className="hero-rise flex items-center gap-3 font-mono text-[0.66rem] tracking-[0.16em] text-ink uppercase">
                <span className="pulse-dot block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                private commerce · robinhood chain
              </div>

              <h1 className="hero-title mt-6 text-[clamp(3.4rem,9.2vw,8.5rem)]">
                <span className="hero-line">
                  <span className="delay-1">Give AI power<span className="text-accent">.</span></span>
                </span>
                <span className="hero-line">
                  <span className="delay-2">
                    Not your privacy<span className="text-accent">.</span>
                  </span>
                </span>
              </h1>

              <p className="hero-rise delay-3 mt-7 max-w-xl text-lg text-ink-dim">
                The next generation of privacy technology. Discover digital services, delegate tasks
                to AI, and stay in control of your identity, data, and permissions.
              </p>

              <div className="hero-rise delay-4 mt-8 flex flex-wrap items-center gap-3">
                <Link href="/market" className="btn">
                  Open the market
                </Link>
                <a href="#how" className="btn-pill">
                  How it works
                  <span className="pill-dot" aria-hidden>
                    ↓
                  </span>
                </a>
              </div>
            </div>

            <aside className="hero-rise delay-5 panel p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
                    live · no custody
                  </div>
                  <div className="mt-3 text-xl font-medium tracking-[-0.03em]">No custody.</div>
                </div>
                <span className="relative block h-10 w-10 shrink-0 overflow-hidden rounded-full border border-line-strong bg-black">
                  <Image
                    src="/brand/logo.jpg"
                    alt=""
                    fill
                    sizes="40px"
                    className="scale-[1.6] object-contain"
                  />
                </span>
              </div>
              <p className="mt-3 text-sm text-ink-dim">
                Payment goes wallet-to-wallet into one fixed NOMA address. The platform never holds
                buyer funds.
              </p>
              <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3 font-mono text-xs">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-ink-dim">price lock</span>
                  <span className="tnum">15 min</span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-ink-dim">settlement</span>
                  <span>wallet → wallet</span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-ink-dim">order key</span>
                  <span>shown once</span>
                </div>
              </div>
            </aside>
          </div>

          <div className="hero-rise delay-5 mt-12 grid grid-cols-2 gap-8 border-t border-line-strong pt-6 sm:gap-16 lg:mt-16">
            <div>
              <div className="text-5xl font-medium tracking-[-0.05em] sm:text-6xl">0</div>
              <div className="mt-2 font-mono text-[0.62rem] tracking-[0.14em] text-ink-dim uppercase">
                accounts to create
              </div>
            </div>
            <div className="border-l border-line pl-8 sm:pl-16">
              <div className="text-5xl font-medium tracking-[-0.05em] sm:text-6xl">
                100<span className="text-accent">%</span>
              </div>
              <div className="mt-2 font-mono text-[0.62rem] tracking-[0.14em] text-ink-dim uppercase">
                wallet-to-wallet
              </div>
            </div>
          </div>
        </div>
      </section>

      <Marquee />

      <div className="shell flex flex-col gap-20 pt-16 sm:gap-24 2xl:gap-28">
        {/* §01 — The market */}
        <section className="reveal">
          <SectionHead
            num="01"
            title={
              <>
                The market. <span className="accent-italic">Four categories, one ledger.</span>
              </>
            }
            lead="Every row is a live product. Pick a category; the price shown is the cheapest one in it right now."
            link={{ href: "/market", label: "browse the market" }}
          />
          <CategoryIndex />
        </section>

        {/* §02 — How it works */}
        <section id="how" className="reveal scroll-mt-24">
          <SectionHead
            num="02"
            title={
              <>
                How it works. <span className="accent-italic">Four steps, no account.</span>
              </>
            }
            lead="Nothing is charged until you create an invoice, and nothing is delivered until the chain confirms it."
          />
          <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <div key={step.n} className="border-t border-line pt-4">
                <div className="font-mono text-[0.62rem] tracking-[0.16em] text-accent">
                  {step.n}
                </div>
                <h3 className="display mt-4 text-2xl">{step.title}</h3>
                <p className="mt-2 text-sm text-ink-dim">{step.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 max-w-3xl text-sm text-ink-dim">
            The payment is one exact amount to one fixed address. The watcher matches it on-chain,
            confirms after a few blocks, and only then calls the supplier.
          </p>
        </section>

        {/* §03 — The reward engine */}
        <section className="reveal">
          <SectionHead
            num="03"
            title={
              <>
                The reward engine. <span className="accent-italic">Paid in ZEC and stock.</span>
              </>
            }
            lead="A 1% creator tax on every $NOMA trade is split 50/50 into ZEC and the Stock of the Week, then streamed to stakers over seven days. The token is not live yet."
            link={{ href: "/rewards", label: "live numbers" }}
          />
          <RewardsCard />

          <div className="mt-10 grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div className="panel p-6">
              <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
                the split
              </div>
              <div className="display mt-4 text-6xl leading-none tracking-[-0.055em] sm:text-7xl">
                50<span className="text-accent"> / </span>50
              </div>
              <p className="mt-4 max-w-sm text-sm text-ink-dim">
                Half to ZEC, half to the Stock of the Week. Both are streamed pro-rata to stake over
                the week, not paid as a lump sum.
              </p>
              <div className="mt-6 flex flex-col gap-2 border-t border-line pt-4 font-mono text-xs">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-ink-dim">creator tax</span>
                  <span>1%</span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-ink-dim">stream</span>
                  <span>7 days</span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-ink-dim">claim</span>
                  <span>claimAll · never expires</span>
                </div>
              </div>
            </div>

            <FigureBox caption="Fig. 01 — the weekly cycle">
              <ol className="flex flex-col">
                {CYCLE.map(([term, note]) => (
                  <li
                    key={term}
                    className="flex items-baseline justify-between gap-6 border-b border-line py-3 last:border-b-0"
                  >
                    <span className="font-mono text-sm text-ink">{term}</span>
                    <span className="text-right text-xs text-ink-dim">{note}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-4 text-sm text-ink-dim">
                Only staked $NOMA earns. Unstaking stops earning immediately; withdraw after the
                7-day cooldown.
              </p>
            </FigureBox>
          </div>
        </section>

        {/* §04 — Built for privacy */}
        <section className="reveal">
          <SectionHead
            num="04"
            title={
              <>
                Built for privacy. <span className="accent-italic">Gated until launch.</span>
              </>
            }
            lead="Four features are built behind flags and switch on after launch. Until then, these plates are the only place they appear."
          />
          <FeatureCarousel features={FEATURE_ART} />
        </section>

        {/* §05 — The agent */}
        <section className="reveal">
          <SectionHead
            num="05"
            title={
              <>
                The agent. <span className="accent-italic">It finds, you decide.</span>
              </>
            }
            lead="The agent searches this catalog, compares products and returns selectable options. It never pays on its own; checkout is the normal flow."
            link={{ href: "/agent", label: "open the agent" }}
          />
          <FigureBox caption="Fig. 02 — a search">
            <div className="flex flex-col gap-4 font-mono text-sm">
              <div>
                <span className="text-ink-dim">you · </span>
                <span className="text-ink">cheapest 20 GB eSIM for Japan</span>
              </div>
              <div>
                <span className="text-ink-dim">noma · </span>
                <span className="text-ink-dim">searching catalog…</span>
              </div>
              <div className="grid gap-px border border-line bg-line sm:grid-cols-3">
                {["JP · 20 GB · 30 days", "JP · 20 GB · 15 days", "JP · 20 GB · 7 days"].map(
                  (option, index) => (
                    <div key={option} className="bg-bg px-3 py-3">
                      <div className="text-ink">{option}</div>
                      <div className="tnum mt-1 text-xs text-accent">option {index + 1}</div>
                    </div>
                  ),
                )}
              </div>
              <p className="text-xs text-ink-dim">
                Every option is a real product. Pick one and the normal checkout opens.
              </p>
            </div>
          </FigureBox>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-6 border-t border-line-strong pt-6">
          <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
            <span>no accounts</span>
            <span>no custody of buyer funds</span>
            <span>every number on-chain</span>
          </div>
          <Link
            href="/market"
            className="font-mono text-[0.66rem] tracking-[0.16em] text-accent uppercase hover:underline"
          >
            open the market →
          </Link>
        </div>
      </div>
    </div>
  );
}
