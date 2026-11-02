import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How NOMA works: no accounts, wallet-to-wallet payment, order keys, delivery, rewards and the agent.",
};

const SECTIONS = [
  { id: "what", n: "01", title: "What NOMA is" },
  { id: "orders", n: "02", title: "How an order works" },
  { id: "payments", n: "03", title: "Payments" },
  { id: "order-key", n: "04", title: "The order key" },
  { id: "delivery", n: "05", title: "Delivery" },
  { id: "rewards", n: "06", title: "Rewards & staking" },
  { id: "agent", n: "07", title: "The agent" },
  { id: "privacy", n: "08", title: "Privacy" },
  { id: "faq", n: "09", title: "FAQ" },
  { id: "ai", n: "10", title: "AI gateway" },
];

const AI_BASE = process.env.NEXT_PUBLIC_AI_BASE_URL ?? "http://<noma-host>/api/ai/v1";

export default function DocsPage() {
  return (
    <div className="grid min-w-0 gap-10 lg:grid-cols-[220px_1fr]">
      <aside className="hidden lg:block">
        <nav className="sticky top-24 flex flex-col gap-1">
          <div className="mb-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
            docs
          </div>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="py-1.5 font-mono text-sm text-ink-dim transition-colors hover:text-accent"
            >
              <span className="tnum mr-2 text-xs">{s.n}</span>
              {s.title}
            </a>
          ))}
        </nav>
      </aside>

      <article className="flex min-w-0 max-w-3xl flex-col gap-14">
        <header>
          <div className="rule-label">docs</div>
          <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">How NOMA works</h1>
          <p className="mt-3 text-base text-ink-dim">
            Everything below is the launch behaviour. Numbers on the site are read from the chain and
            the API; nothing here is a promise of a value we do not serve.
          </p>
          <details className="mt-6 border-y border-line py-1 lg:hidden">
            <summary className="flex min-h-11 cursor-pointer items-center font-mono text-[0.68rem] tracking-[0.16em] text-ink-dim uppercase marker:text-accent">
              on this page
            </summary>
            <nav className="grid gap-x-4 pb-3 sm:grid-cols-2">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="flex min-h-11 items-center py-1 font-mono text-sm text-ink-dim transition-colors hover:text-accent"
                >
                  <span className="tnum mr-2 text-xs">{s.n}</span>
                  {s.title}
                </a>
              ))}
            </nav>
          </details>
        </header>

        <section id="what" className="scroll-mt-24">
          <div className="rule-label">§01 — what</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">What NOMA is</h2>
          <p className="mt-3 text-sm text-ink-dim">
            NOMA is a private commerce layer for digital services. You buy with crypto, you never
            create an account, and identity is either a wallet signature or an order key.
          </p>
          <ul className="mt-3 flex flex-col gap-1 font-mono text-sm text-ink-dim">
            <li>· eSIM · AI credits · VPN · proxy · VPS · gift cards</li>
            <li>· payments are wallet-to-wallet; the platform never holds your funds</li>
            <li>· staked $NOMA earns the weekly rewards (once the token is live)</li>
          </ul>
        </section>

        <section id="orders" className="scroll-mt-24">
          <div className="rule-label">§02 — orders</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">How an order works</h2>
          <ol className="mt-4 flex flex-col gap-3">
            {[
              ["Choose", "The product page lists exactly what you provide and what you receive, before you pay anything."],
              ["Pay", "An invoice locks the price for 15 minutes. It names the exact amount and the fixed NOMA address."],
              ["Receive", "Payment is confirmed on-chain, the supplier is called, and the deliverable is stored encrypted — shown only to whoever holds the order key."],
              ["Prove (optional)", "Attach the order to a wallet and it appears in your order index. Otherwise the order key is the only credential."],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-4 border border-line bg-bg-raised px-4 py-3">
                <span className="tnum font-mono text-xs text-ink-dim">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <div className="text-sm text-ink">{title}</div>
                  <p className="mt-0.5 text-sm text-ink-dim">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="payments" className="scroll-mt-24">
          <div className="rule-label">§03 — payments</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">Payments</h2>
          <p className="mt-3 text-sm text-ink-dim">
            Pay in <span className="text-ink">USDG</span> (the canonical stablecoin on Robinhood
            Chain) or <span className="text-ink">ETH</span>. The buyer pays wallet-to-wallet into one
            fixed NOMA address; the platform never holds a balance for the buyer.
          </p>
          <div className="mt-4 border border-line bg-bg-raised p-4 font-mono text-sm">
            <div className="flex justify-between">
              <span className="text-ink-dim">method</span>
              <span>wallet → NOMA address</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-dim">identifier</span>
              <span>the exact invoice amount</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-dim">custody</span>
              <span>none · no escrow</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-dim">price lock</span>
              <span>15 minutes</span>
            </div>
          </div>
          <p className="mt-4 text-sm text-ink-dim">
            Each invoice has a unique amount — send <span className="text-ink">exactly</span> it. The
            watcher confirms after a few blocks and only then fulfills. A payment that arrives after
            the invoice expired is refunded in full to the payer.
          </p>
        </section>

        <section id="order-key" className="scroll-mt-24">
          <div className="rule-label">§04 — order key</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">The order key</h2>
          <p className="mt-3 text-sm text-ink-dim">
            The order key is returned once when the invoice is created; only its hash is stored. It is
            the only way back to an anonymous order — and it cannot be recovered or reset. That is the
            cost of having no accounts.
          </p>
          <p className="mt-3 text-sm text-ink-dim">
            The key lives in the URL fragment, so it never reaches the server logs. If you paid from a
            connected wallet, the order also appears in your order index.
          </p>
        </section>

        <section id="delivery" className="scroll-mt-24">
          <div className="rule-label">§05 — delivery</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">Delivery</h2>
          <p className="mt-3 text-sm text-ink-dim">
            The deliverable is encrypted at rest and shown only to the order-key holder. What you get
            depends on the category:
          </p>
          <div className="mt-4 divide-y divide-line border border-line font-mono text-sm">
            {[
              ["eSIM", "an LPA activation string + QR"],
              ["VPS", "host, root password, ssh one-liner"],
              ["AI credits", "an API key with its credit limit"],
              ["Gift card", "the code and any PIN"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between px-4 py-2">
                <span className="text-ink-dim">{k}</span>
                <span className="text-right">{v}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="rewards" className="scroll-mt-24">
          <div className="rule-label">§06 — rewards</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">Rewards &amp; staking</h2>
          <p className="mt-3 text-sm text-ink-dim">
            $NOMA trades on Pons with a 1% creator tax. At cycle end the Reward Engine Safe claims the
            fees, swaps them 50/50 into ZEC and the Stock of the Week, and streams both into
            NomaStaking over 7 days.
          </p>
          <ul className="mt-3 flex flex-col gap-1 font-mono text-sm text-ink-dim">
            <li>· only staked $NOMA earns</li>
            <li>· unstaking stops earning immediately; withdraw after a 7-day cooldown</li>
            <li>· rewards stream over 7 days and never expire; claim anytime with claimAll</li>
            <li>· staking and the reward engine activate when the token launches</li>
          </ul>
        </section>

        <section id="agent" className="scroll-mt-24">
          <div className="rule-label">§07 — agent</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">The agent</h2>
          <p className="mt-3 text-sm text-ink-dim">
            The agent searches the NOMA catalog only. It compares products and returns selectable
            options. It never pays on its own — checkout is the normal flow.
          </p>
        </section>

        <section id="privacy" className="scroll-mt-24">
          <div className="rule-label">§08 — privacy</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">Privacy</h2>
          <p className="mt-3 text-sm text-ink-dim">
            An order shares only the fields the supplier needs to deliver it. The checkout shows them
            before you pay; the order page keeps the receipt. Deliverables are encrypted at rest and
            are never assembled for anyone but the order-key holder.
          </p>
        </section>

        <section id="faq" className="scroll-mt-24">
          <div className="rule-label">§09 — faq</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">FAQ</h2>
          <dl className="mt-4 flex flex-col gap-4">
            {[
              ["Do I need an account?", "No. Identity is a wallet signature or an order key."],
              ["What if I lose the order key?", "The order cannot be recovered. If you paid from a connected wallet, it stays in your order index."],
              ["What if the supplier fails?", "The order is refunded automatically to the payer address."],
              ["Which assets can I pay with?", "USDG or ETH on Robinhood Chain. USDG is pegged at $1."],
              ["Is the reward engine live?", "Not yet. It activates when $NOMA launches and staking is deployed."],
              ["Where are the contract addresses?", "In the footer, once they exist. Nothing is deployed until launch."],
            ].map(([q, a]) => (
              <div key={q} className="border border-line bg-bg-raised p-4">
                <dt className="text-sm text-ink">{q}</dt>
                <dd className="mt-1 text-sm text-ink-dim">{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="ai" className="scroll-mt-24">
          <div className="rule-label">§10 — ai gateway</div>
          <h2 className="mt-4 text-3xl font-medium tracking-[-0.04em]">AI gateway</h2>
          <p className="mt-3 text-sm text-ink-dim">
            AI credits are sold as a NOMA API key, not an OpenRouter key. The OpenRouter key stays on
            our server; your key calls NOMA, and NOMA calls the model. The endpoint is
            OpenAI-compatible, so any SDK or client that accepts a base URL works.
          </p>

          <div className="mt-4 border border-line bg-bg-raised p-4 font-mono text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-ink-dim">base url</span>
              <span className="min-w-0 break-all text-right">{AI_BASE}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-dim">auth</span>
              <span>Bearer noma_sk_…</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-dim">compatible</span>
              <span>OpenAI chat completions</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-dim">usage</span>
              <span>OpenRouter cost + platform fee</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-dim">balance</span>
              <span>the amount you paid</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-ink-dim">expiry</span>
              <span>shown on delivery · 365 days by default</span>
            </div>
          </div>

          <h3 className="mt-6 text-lg">Request</h3>
          <pre className="mt-2 overflow-x-auto border border-line bg-bg p-4 font-mono text-xs leading-5 text-ink-dim">{`curl ${AI_BASE}/chat/completions \\
  -H "Authorization: Bearer noma_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<model>","messages":[{"role":"user","content":"hello"}]}'`}</pre>

          <h3 className="mt-6 text-lg">OpenAI SDK</h3>
          <pre className="mt-2 overflow-x-auto border border-line bg-bg p-4 font-mono text-xs leading-5 text-ink-dim">{`from openai import OpenAI

client = OpenAI(base_url="${AI_BASE}", api_key="noma_sk_...")
print(client.chat.completions.create(
    model="<model>",
    messages=[{"role": "user", "content": "hello"}],
))`}</pre>

          <h3 className="mt-6 text-lg">Usage and balance</h3>
          <p className="mt-2 text-sm text-ink-dim">
            Your balance is the amount you paid. Each request is billed at the model&apos;s OpenRouter
            cost plus the platform fee, and the balance is debited per request. When it reaches
            zero, requests are refused until you buy another key.
          </p>
          <pre className="mt-2 overflow-x-auto border border-line bg-bg p-4 font-mono text-xs leading-5 text-ink-dim">{`curl ${AI_BASE}/usage \\
  -H "Authorization: Bearer noma_sk_..."`}</pre>

          <h3 className="mt-6 text-lg">Rules</h3>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-sm text-ink-dim">
            <li>· the key is a bearer secret; anyone holding it can spend the balance</li>
            <li>· the key expires; unused credit expires with it</li>
            <li>· prompts go to OpenRouter and the model provider; NOMA stores tokens and cost, not message bodies</li>
            <li>· only the models listed on the product page are accepted</li>
            <li>· no refunds after the key is issued; a leaked key can be revoked from the admin side</li>
            <li>· use the HTTPS endpoint for real keys; a bearer key over plain HTTP is exposed</li>
          </ul>
        </section>

        <footer className="border-t border-line pt-6">
          <Link href="/market" className="font-mono text-sm text-accent hover:underline">
            open the market →
          </Link>
        </footer>
      </article>
    </div>
  );
}
