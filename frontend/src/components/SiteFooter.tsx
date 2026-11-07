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

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
      width="16"
      height="16"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function XMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
      width="16"
      height="16"
    >
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

function TelegramMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
      width="16"
      height="16"
    >
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

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
                  href="https://x.com/NomaApps"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-9 items-center gap-2 text-sm text-ink transition-colors hover:text-accent"
                >
                  <XMark className="h-4 w-4" />
                  X ↗
                </a>
                <a
                  href="https://t.me/NOMA_Privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-9 items-center gap-2 text-sm text-ink transition-colors hover:text-accent"
                >
                  <TelegramMark className="h-4 w-4" />
                  Telegram ↗
                </a>
                <a
                  href="https://github.com/Usenoma/noma-project"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-9 items-center gap-2 text-sm text-ink transition-colors hover:text-accent"
                >
                  <GithubMark className="h-4 w-4" />
                  GitHub ↗
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
