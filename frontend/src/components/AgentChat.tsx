"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { agentChat } from "@/lib/api";
import { categoryLabel, specLine, usd } from "@/lib/format";
import type { AgentOption } from "@/lib/types";

interface Message {
  role: "you" | "noma";
  text: string;
  options?: AgentOption[];
}

export function AgentChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "you", text }]);
    try {
      const res = await agentChat({ session_id: sessionId, message: text });
      setSessionId(res.session_id);
      setMessages((m) => [
        ...m,
        { role: "noma", text: res.message, options: res.options.length ? res.options : undefined },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "agent error";
      if (msg.includes("not configured")) {
        setUnavailable(true);
      } else {
        setMessages((m) => [...m, { role: "noma", text: msg }]);
      }
    } finally {
      setBusy(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <div className="rule-label">noma agent</div>
        <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">What do you need?</h1>
        <p className="mt-3 font-mono text-xs text-ink-dim">
          this conversation is not tied to any account and is not shown again
        </p>
      </div>

      <div className="flex min-h-72 flex-col gap-4 border border-line bg-bg-raised p-4">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="font-mono text-sm text-ink-dim">
              describe what you need, or start from one of these:
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                "cheapest 20 GB eSIM for Japan",
                "a VPS in Frankfurt under $10",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="inline-flex min-h-11 items-center border border-line px-3 text-left font-mono text-xs text-ink-dim transition-colors hover:border-accent hover:text-accent"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="font-mono text-sm">
                <span className="text-ink-dim">{m.role} · </span>
                <span className={m.role === "you" ? "text-ink" : "text-ink"}>{m.text}</span>
              </div>
              {m.options ? (
                <div className="grid gap-px border border-line bg-line sm:grid-cols-2">
                  {m.options.map((o) => (
                    <div key={o.product_id} className="bg-bg p-3">
                      <div className="text-sm text-ink">{o.title}</div>
                      <div className="tnum mt-1 font-mono text-xs text-ink-dim">
                        {categoryLabel(o.category)}
                        {o.region ? ` · ${o.region}` : ""}
                        {specLine(o.category, o.specs) ? ` · ${specLine(o.category, o.specs)}` : ""}
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="tnum font-mono text-sm">{usd(o.price_usd)}</span>
                        <Link
                          href={`/p/${o.product_id}`}
                          className="inline-flex min-h-11 items-center border border-line px-3 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent"
                        >
                          pick
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        )}
        {busy ? <p className="font-mono text-sm text-ink-dim">searching catalog…</p> : null}
        <div ref={bottomRef} />
      </div>

      {unavailable ? (
        <p className="font-mono text-sm text-ink-dim">
          agent unavailable —{" "}
          <Link href="/market" className="text-accent hover:underline">
            browse the market
          </Link>
        </p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2">
          <label htmlFor="agent-input" className="field-label">
            your request
          </label>
          <div className="flex gap-2">
            <input
              id="agent-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="describe what you need…"
              maxLength={2000}
              disabled={busy}
              className="field min-w-0 flex-1"
            />
            <button type="submit" disabled={busy || !input.trim()} className="btn">
              send
            </button>
          </div>
        </form>
      )}
      <p className="font-mono text-xs text-ink-dim">
        the agent searches the NOMA catalog and never pays on its own. checkout is the normal flow.
      </p>
    </div>
  );
}
