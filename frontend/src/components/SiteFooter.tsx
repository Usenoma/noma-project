import Link from "next/link";

const CONTRACTS: { label: string; address: string }[] = [
  { label: "$NOMA", address: process.env.NEXT_PUBLIC_NOMA_TOKEN_ADDRESS ?? "" },
  { label: "NomaStaking", address: process.env.NEXT_PUBLIC_NOMA_STAKING_ADDRESS ?? "" },
  { label: "Reward Safe", address: process.env.NEXT_PUBLIC_SAFE_ADDRESS ?? "" },
].filter((c) => c.address);

const EXPLORE = [
  { href: "/market", label: "Market" },
  { href: "/rewards", label: "Rewards" },
  { href: "/docs", label: "Docs" },
  { href: "/agent", label: "Agent" },
];

const RECORD = [
  { href: "/orders", label: "Orders" },
  { href: "/lookup", label: "Lookup" },
  { href: "/status", label: "Status" },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="shell py-14">
        <div className="grid gap-12 md:grid-cols-[1fr_auto]">
          <div>
            <div className="rule-label">noma</div>
            <div className="display mt-5 text-4xl leading-[0.95] sm:text-6xl">
              No more
              <br />
              accounts<span className="text-accent">.</span>
            </div>
            <p className="mt-4 max-w-md text-sm text-ink-dim">
              Private commerce for digital services. Wallet to wallet on Robinhood Chain. No
              accounts, no custody of buyer funds.
            </p>
            <Link href="/market" className="btn mt-7">
              Open the market
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:gap-16">
            <nav aria-label="Explore">
              <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
                explore
              </div>
              <div className="mt-3 flex flex-col">
                {EXPLORE.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="inline-flex min-h-9 items-center text-sm text-ink transition-colors hover:text-accent"
                  >
                    {item.label}
                  </Link>
                ))}
                <a
                  href="https://x.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-9 items-center text-sm text-ink transition-colors hover:text-accent"
                >
                  X ↗
                </a>
              </div>
            </nav>
            <nav aria-label="Your record">
              <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
                record
              </div>
              <div className="mt-3 flex flex-col">
                {RECORD.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="inline-flex min-h-9 items-center text-sm text-ink transition-colors hover:text-accent"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </nav>
          </div>
        </div>

        {CONTRACTS.length > 0 ? (
          <div className="mt-12 border-t border-line pt-5">
            {CONTRACTS.map((c) => (
              <div key={c.label} className="tnum font-mono text-[0.66rem] text-ink-dim">
                {c.label}: <span className="text-ink">{c.address}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-12 flex flex-wrap items-end justify-between gap-6 border-t border-line pt-6">
          <div className="wordmark text-lg leading-none">NOMA</div>
          <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
            no more accounts · robinhood chain
          </div>
          <div className="font-mono text-[0.62rem] tracking-[0.16em] text-ink-dim uppercase">
            © 2026
          </div>
        </div>
      </div>
    </footer>
  );
}
