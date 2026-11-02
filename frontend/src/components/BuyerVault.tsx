"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  ApiError,
  createWalletSession,
  getOrder,
  getOrdersByWallet,
} from "@/lib/api";
import { dateTime, shortAddress, usd } from "@/lib/format";
import { forgetOrder, listRememberedOrders, rememberOrder } from "@/lib/orderKey";
import {
  clearWalletSession,
  getWalletSession,
  saveWalletSession,
  walletAuthMessage,
} from "@/lib/walletSession";
import type { OrderStatus, OrderSummary, OrderView as OrderViewData, WalletSession } from "@/lib/types";
import { EmptyState } from "./EmptyState";
import { OrderView as OrderDetail } from "./OrderView";
import { Stat } from "./Stat";
import { StateWord } from "./StateWord";
import { WalletButton } from "./WalletButton";

const PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Tab = "wallet" | "device";
type Filter = "all" | "pay" | "active" | "delivered" | "closed";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "all" },
  { value: "pay", label: "to pay" },
  { value: "active", label: "in progress" },
  { value: "delivered", label: "delivered" },
  { value: "closed", label: "refunds" },
];

const GROUPS: Record<Filter, OrderStatus[] | null> = {
  all: null,
  pay: ["created", "awaiting_payment"],
  active: ["paid", "fulfilling"],
  delivered: ["delivered"],
  closed: ["expired", "failed", "refunding", "refunded"],
};

function matches(status: OrderStatus, filter: Filter): boolean {
  const group = GROUPS[filter];
  return group === null || group.includes(status);
}

interface Row {
  id: string;
  title: string;
  status: OrderStatus;
  created_at: string;
  price_usd: string;
  has_deliverable: boolean;
}

function fromSummary(order: OrderSummary): Row {
  return {
    id: order.id,
    title: order.title,
    status: order.status,
    created_at: order.created_at,
    price_usd: order.price_usd,
    has_deliverable: order.has_deliverable,
  };
}

function fromView(order: OrderViewData): Row {
  return {
    id: order.id,
    title: order.title,
    status: order.status,
    created_at: order.created_at,
    price_usd: order.price_usd,
    has_deliverable: order.deliverables.length > 0,
  };
}

function RowButton({
  row,
  active,
  source,
  onSelect,
  onForget,
}: {
  row: Row;
  active: boolean;
  source: Tab;
  onSelect: () => void;
  onForget?: () => void;
}) {
  return (
    <div className={`flex items-stretch border-b border-line last:border-b-0 ${active ? "bg-bg-raised" : ""}`}>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-h-16 min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-3 text-left transition-colors hover:bg-bg-raised"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm">{row.title}</span>
          <StateWord state={row.status} />
        </span>
        <span className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[0.66rem] text-ink-dim">
          <span className="tnum">
            {dateTime(row.created_at)} · {usd(row.price_usd)}
          </span>
          <span className={row.has_deliverable ? "text-accent" : ""}>
            {source === "device" ? "this device" : row.has_deliverable ? "credentials" : ""}
          </span>
        </span>
      </button>
      {onForget ? (
        <button
          type="button"
          onClick={onForget}
          className="px-3 font-mono text-[0.66rem] tracking-widest text-ink-dim uppercase transition-colors hover:text-bad"
          aria-label={`forget order ${row.id}`}
        >
          forget
        </button>
      ) : null}
    </div>
  );
}

export function BuyerVault() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync, isPending } = useSignMessage();

  const [session, setSession] = useState<WalletSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [tab, setTab] = useState<Tab>("wallet");
  const [filter, setFilter] = useState<Filter>("all");
  const [walletOrders, setWalletOrders] = useState<OrderSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [spend, setSpend] = useState("0");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [localKeys, setLocalKeys] = useState<{ orderId: string; key: string }[]>([]);
  const [localOrders, setLocalOrders] = useState<Record<string, OrderViewData | "invalid">>({});
  const [localLoading, setLocalLoading] = useState(true);
  const [localVersion, setLocalVersion] = useState(0);
  const [selected, setSelected] = useState<{ id: string; source: Tab } | null>(null);
  const [addId, setAddId] = useState("");
  const [addKey, setAddKey] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Read the tab session after mount so SSR and hydration render the same shell.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(getWalletSession());
     
    setSessionChecked(true);
  }, []);

  // Switching wallets must never show another address's session.
  useEffect(() => {
    if (session && address && session.address.toLowerCase() !== address.toLowerCase()) signOut();
     
  }, [address, session]);

  useEffect(() => {
    if (!session) return;
    const remaining = Date.parse(session.expires_at) - Date.now();
    if (remaining <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSession(null);
      return;
    }
    const timer = setTimeout(() => {
      clearWalletSession();
      setSession(null);
      setWalletError("session expired — sign in again to read wallet orders");
    }, remaining);
    return () => clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
     
    setWalletError(null);
    getOrdersByWallet(session.token, { limit: PAGE, offset: 0 })
      .then((res) => {
        if (!alive) return;
        setWalletOrders(res.orders);
        setTotal(res.total);
        setSpend(res.spend_usd);
        setSelected((current) => current ?? (res.orders[0] ? { id: res.orders[0].id, source: "wallet" } : null));
      })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          clearWalletSession();
          setSession(null);
          setWalletError("session expired — sign in again to read wallet orders");
        } else {
          setWalletError(err instanceof Error ? err.message : "could not load orders");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [session]);

  useEffect(() => {
    const keys = listRememberedOrders();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalKeys(keys);
    if (keys.length === 0) {
       
      setLocalOrders({});
       
      setLocalLoading(false);
      return;
    }
    let alive = true;
     
    setLocalLoading(true);
    Promise.all(
      keys.map(async ({ orderId, key }) => {
        try {
          const order = await getOrder(orderId, key);
          return [orderId, order] as const;
        } catch {
          return [orderId, "invalid"] as const;
        }
      }),
    )
      .then((entries) => {
        if (alive) setLocalOrders(Object.fromEntries(entries));
      })
      .finally(() => {
        if (alive) setLocalLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [localVersion]);

  async function signIn() {
    if (!address || isPending) return;
    setSignError(null);
    try {
      const timestamp = Date.now();
      const signature = await signMessageAsync({ message: walletAuthMessage(address, timestamp) });
      const next = await createWalletSession({ address, signature, timestamp });
      saveWalletSession(next);
      setSession(next);
      setWalletError(null);
    } catch (err) {
      setSignError(err instanceof Error ? err.message.split("\n")[0] : "signature rejected");
    }
  }

  function signOut() {
    clearWalletSession();
    setSession(null);
    setWalletOrders([]);
    setTotal(0);
    setSpend("0");
    setWalletError(null);
    setSelected((current) => (current?.source === "wallet" ? null : current));
  }

  async function loadMore() {
    if (!session || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getOrdersByWallet(session.token, { limit: PAGE, offset: walletOrders.length });
      setWalletOrders((prev) => {
        const ids = new Set(prev.map((o) => o.id));
        return [...prev, ...res.orders.filter((o) => !ids.has(o.id))];
      });
      setTotal(res.total);
      setSpend(res.spend_usd);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearWalletSession();
        setSession(null);
        setWalletError("session expired — sign in again to read wallet orders");
      } else {
        setWalletError(err instanceof Error ? err.message : "could not load more orders");
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function addLocal(e: React.FormEvent) {
    e.preventDefault();
    const id = addId.trim().toLowerCase();
    const key = addKey.trim();
    if (!UUID.test(id)) {
      setAddError("enter the order id (the uuid in the order URL)");
      return;
    }
    if (!key.startsWith("nok_")) {
      setAddError("enter the order key (starts with nok_)");
      return;
    }
    rememberOrder(id, key);
    setAddId("");
    setAddKey("");
    setAddError(null);
    setLocalVersion((v) => v + 1);
    setSelected({ id, source: "device" });
    setTab("device");
  }

  function removeLocal(id: string) {
    forgetOrder(id);
    setLocalVersion((v) => v + 1);
    setSelected((current) => (current?.source === "device" && current.id === id ? null : current));
  }

  const known = useMemo(() => {
    const map = new Map<string, { price_usd: string; has_deliverable: boolean }>();
    for (const order of walletOrders) {
      map.set(order.id, { price_usd: order.price_usd, has_deliverable: order.has_deliverable });
    }
    for (const { orderId } of localKeys) {
      const order = localOrders[orderId];
      if (order && order !== "invalid") {
        map.set(orderId, { price_usd: order.price_usd, has_deliverable: order.deliverables.length > 0 });
      }
    }
    return map;
  }, [walletOrders, localKeys, localOrders]);

  const deliverables = [...known.values()].filter((order) => order.has_deliverable).length;

  const walletRows = walletOrders.map(fromSummary).filter((row) => matches(row.status, filter));

  const deviceRows = localKeys
    .map(({ orderId }) => {
      const value = localOrders[orderId];
      if (value === "invalid") return { kind: "invalid" as const, id: orderId };
      if (!value) return { kind: "loading" as const, id: orderId };
      return { kind: "row" as const, id: orderId, row: fromView(value) };
    })
    .filter((entry) => (entry.kind === "row" ? matches(entry.row.status, filter) : filter === "all"))
    .sort((a, b) => {
      if (a.kind === "row" && b.kind === "row") {
        return Date.parse(b.row.created_at) - Date.parse(a.row.created_at);
      }
      if (a.kind === "row") return -1;
      if (b.kind === "row") return 1;
      return 0;
    });

  const selectedKey =
    selected?.source === "device" ? (localKeys.find((entry) => entry.orderId === selected.id)?.key ?? null) : null;
  const canOpen = selected ? selected.source === "wallet" || Boolean(selectedKey) : false;
  const showWalletList = session !== null || walletOrders.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className="rule-label">buyer vault</div>
        <h1 className="mt-4 text-4xl tracking-[-0.045em] sm:text-5xl xl:text-6xl">Your orders</h1>
        <p className="mt-3 max-w-2xl text-base text-ink-dim">
          Wallet history and order keys saved on this device: state, invoice and credentials in one
          place. No account, no custody.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
        <Stat
          label="wallet orders"
          value={session ? String(total) : sessionChecked ? "—" : "…"}
          caption="paid or attached"
        />
        <Stat label="device keys" value={String(localKeys.length)} caption="this browser" />
        <Stat
          label="wallet spend"
          value={session ? usd(spend) : sessionChecked ? "—" : "…"}
          caption="all wallet orders"
        />
        <Stat label="deliverables" value={String(deliverables)} caption="ready to open" />
      </div>

      <div className="grid gap-8 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 border-y border-line">
            <button
              type="button"
              onClick={() => setTab("wallet")}
              className={`flex min-h-11 items-center justify-center border-b-2 font-mono text-[0.7rem] tracking-widest uppercase transition-colors ${
                tab === "wallet" ? "border-accent text-accent" : "border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              wallet {session ? `(${total})` : ""}
            </button>
            <button
              type="button"
              onClick={() => setTab("device")}
              className={`flex min-h-11 items-center justify-center border-b-2 font-mono text-[0.7rem] tracking-widest uppercase transition-colors ${
                tab === "device" ? "border-accent text-accent" : "border-transparent text-ink-dim hover:text-ink"
              }`}
            >
              this device ({localKeys.length})
            </button>
          </div>

          <div className="border border-line bg-bg-raised p-4">
            {!sessionChecked ? (
              <p className="font-mono text-sm text-ink-dim">checking session…</p>
            ) : session ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[0.65rem] tracking-widest text-accent uppercase">
                    read-only session
                  </span>
                  <button
                    type="button"
                    onClick={signOut}
                    className="font-mono text-[0.65rem] tracking-widest text-ink-dim uppercase hover:text-ink"
                  >
                    sign out
                  </button>
                </div>
                <div className="tnum mt-2 font-mono text-sm text-ink">{shortAddress(session.address)}</div>
                <p className="mt-1 font-mono text-[0.65rem] text-ink-dim">
                  expires {dateTime(session.expires_at)} · orders only
                </p>
              </>
            ) : !isConnected ? (
              <>
                <p className="font-mono text-sm text-ink-dim">
                  connect a wallet to read orders paid from or attached to it.
                </p>
                <div className="mt-3">
                  <WalletButton />
                </div>
              </>
            ) : (
              <>
                <p className="font-mono text-sm text-ink-dim">
                  sign a message to read <span className="text-ink">{shortAddress(address ?? "")}</span>.
                  no transaction, no gas.
                </p>
                <button type="button" onClick={signIn} disabled={isPending} className="btn mt-3 w-full">
                  {isPending ? "confirm in wallet…" : "sign in"}
                </button>
                {signError ? <p className="mt-2 font-mono text-xs text-bad">{signError}</p> : null}
              </>
            )}
            {walletError ? <p className="mt-3 font-mono text-xs text-bad">{walletError}</p> : null}
          </div>

          <div className="flex flex-wrap gap-1">
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setFilter(entry.value)}
                className={`min-h-9 border px-2.5 font-mono text-[0.64rem] tracking-widest uppercase transition-colors ${
                  filter === entry.value
                    ? "border-accent text-accent"
                    : "border-line text-ink-dim hover:text-ink"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "wallet" ? (
            !session && !showWalletList ? (
              <p className="border border-line bg-bg-raised px-4 py-4 font-mono text-sm text-ink-dim">
                sign in above to load wallet orders.
              </p>
            ) : loading && walletOrders.length === 0 ? (
              <p className="font-mono text-sm text-ink-dim">loading orders…</p>
            ) : walletRows.length === 0 ? (
              <EmptyState
                line={walletOrders.length === 0 ? "no orders for this wallet" : "no orders in this filter"}
                action={walletOrders.length === 0 ? { href: "/market", label: "browse the market" } : undefined}
              />
            ) : (
              <div className="border-t border-line">
                {walletRows.map((row) => (
                  <RowButton
                    key={row.id}
                    row={row}
                    active={selected?.source === "wallet" && selected.id === row.id}
                    source="wallet"
                    onSelect={() => setSelected({ id: row.id, source: "wallet" })}
                  />
                ))}
                {walletOrders.length < total ? (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="flex min-h-11 w-full items-center justify-center border-b border-line font-mono text-xs tracking-widest text-ink-dim uppercase transition-colors hover:text-accent disabled:opacity-50"
                  >
                    {loadingMore ? "loading…" : `load more · ${walletOrders.length} / ${total}`}
                  </button>
                ) : null}
              </div>
            )
          ) : (
            <>
              {localLoading && localKeys.length === 0 ? (
                <p className="font-mono text-sm text-ink-dim">reading remembered orders…</p>
              ) : deviceRows.length === 0 ? (
                <EmptyState
                  line={localKeys.length === 0 ? "no orders saved on this device" : "no orders in this filter"}
                />
              ) : (
                <div className="border-t border-line">
                  {deviceRows.map((entry) => {
                    if (entry.kind === "row") {
                      return (
                        <RowButton
                          key={entry.id}
                          row={entry.row}
                          active={selected?.source === "device" && selected.id === entry.id}
                          source="device"
                          onSelect={() => setSelected({ id: entry.id, source: "device" })}
                          onForget={() => removeLocal(entry.id)}
                        />
                      );
                    }
                    return (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between gap-3 border-b border-line px-3 py-3 font-mono text-xs text-ink-dim"
                      >
                        <span className="min-w-0 truncate">
                          {entry.id} ·{" "}
                          {entry.kind === "invalid" ? "key no longer opens this order" : "reading…"}
                        </span>
                        {entry.kind === "invalid" ? (
                          <button
                            type="button"
                            onClick={() => removeLocal(entry.id)}
                            className="shrink-0 tracking-widest uppercase hover:text-bad"
                          >
                            forget
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              <form onSubmit={addLocal} className="border border-line bg-bg-raised p-4">
                <div className="rule-label">open an order on this device</div>
                <label htmlFor="vault-order-id" className="field-label mt-3">
                  order id
                </label>
                <input
                  id="vault-order-id"
                  type="text"
                  value={addId}
                  onChange={(e) => setAddId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  spellCheck={false}
                  className="field"
                />
                <label htmlFor="vault-order-key" className="field-label mt-3">
                  order key
                </label>
                <input
                  id="vault-order-key"
                  type="text"
                  value={addKey}
                  onChange={(e) => setAddKey(e.target.value)}
                  placeholder="nok_…"
                  spellCheck={false}
                  autoComplete="off"
                  className="field"
                />
                {addError ? <p className="mt-2 font-mono text-xs text-bad">{addError}</p> : null}
                <button type="submit" className="btn mt-3 w-full">
                  remember and open
                </button>
                <p className="mt-2 text-xs text-ink-dim">
                  the key stays in this browser; clearing site data removes it. only save keys on a
                  device you trust.
                </p>
              </form>
            </>
          )}
        </aside>

        <section className="min-w-0 border-t border-line pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          {selected && canOpen ? (
            <OrderDetail
              key={`${selected.source}:${selected.id}`}
              orderId={selected.id}
              initialKey={selected.source === "device" ? selectedKey : null}
              walletToken={selected.source === "wallet" ? (session?.token ?? null) : null}
              embedded
            />
          ) : (
            <EmptyState
              line={
                selected
                  ? "this order key is no longer on this device"
                  : "select an order to see its state, invoice and credentials"
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}
