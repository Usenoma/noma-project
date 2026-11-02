"use client";

import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { getLookup } from "@/lib/api";
import { ERC20_ABI, NOMA_STAKING_ABI, NOMA_STAKING_ADDRESS, NOMA_TOKEN_ADDRESS } from "@/lib/abi";
import { amount, usd } from "@/lib/format";
import { Countdown } from "./Countdown";

const NOMA_DECIMALS = 18;

const STAKING_ADDR = (NOMA_STAKING_ADDRESS || undefined) as `0x${string}` | undefined;
const TOKEN_ADDR = (NOMA_TOKEN_ADDRESS || undefined) as `0x${string}` | undefined;

export function StakingPanel() {
  const configured = !!STAKING_ADDR && !!TOKEN_ADDR;
  if (!configured) {
    return (
      <div className="border border-line bg-bg-raised">
        <div className="border-b border-line px-4 py-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          staking
        </div>
        <p className="p-4 text-sm text-ink-dim">
          Staking launches with $NOMA. Staked $NOMA earns the weekly ZEC and Stock of the Week —
          stake, unstake (7-day cooldown) and claim anytime. Not live yet.
        </p>
      </div>
    );
  }
  return <StakingPanelLive staking={STAKING_ADDR!} token={TOKEN_ADDR!} />;
}

function StakingPanelLive({ staking, token }: { staking: `0x${string}`; token: `0x${string}` }) {
  const { address, isConnected } = useAccount();
  const { mutate } = useSWRConfig();

  const { data: position } = useSWR(
    address ? ["lookup", address] : null,
    () => getLookup(address!),
    { refreshInterval: 30_000 },
  );

  const { data: balance } = useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: allowance } = useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, staking] : undefined,
    query: { enabled: !!address },
  });

  return (
    <div className="border border-line bg-bg-raised">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
        <span className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          staking
        </span>
        {!isConnected ? (
          <span className="font-mono text-xs text-ink-dim">connect wallet to stake</span>
        ) : (
          <span className="tnum font-mono text-xs text-ink-dim">{address}</span>
        )}
      </div>
      <div className="p-4">
        {!isConnected || !address ? (
          <p className="font-mono text-sm text-ink-dim">
            Only staked $NOMA earns the weekly ZEC and Stock of the Week. Connect a wallet to stake,
            unstake or claim.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            <Position position={position} balance={balance as bigint | undefined} />
            <StakeForm
              staking={staking}
              token={token}
              allowance={allowance as bigint | undefined}
              onDone={() => mutate(["lookup", address])}
            />
            <UnstakeForm
              staking={staking}
              staked={position ? BigInt(position.staked) : 0n}
              onDone={() => mutate(["lookup", address])}
            />
            <WithdrawClaim
              staking={staking}
              position={position}
              onDone={() => mutate(["lookup", address])}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Position({
  position,
  balance,
}: {
  position?: Awaited<ReturnType<typeof getLookup>>;
  balance?: bigint;
}) {
  const staked = position ? BigInt(position.staked) : 0n;
  const pending = position ? BigInt(position.pending_unstake) : 0n;
  const totalClaimableUsd =
    position?.claimable.reduce((s, c) => s + (parseFloat(c.usd ?? "0") || 0), 0) ?? 0;

  return (
    <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
      <div className="bg-bg px-3 py-2">
        <div className="font-mono text-[0.7rem] text-ink-dim uppercase">staked</div>
        <div className="tnum mt-0.5 font-mono">{formatUnits(staked, NOMA_DECIMALS)}</div>
      </div>
      <div className="bg-bg px-3 py-2">
        <div className="font-mono text-[0.7rem] text-ink-dim uppercase">wallet</div>
        <div className="tnum mt-0.5 font-mono">
          {balance != null ? formatUnits(balance, NOMA_DECIMALS) : "—"}
        </div>
      </div>
      <div className="bg-bg px-3 py-2">
        <div className="font-mono text-[0.7rem] text-ink-dim uppercase">pending unstake</div>
        <div className="tnum mt-0.5 font-mono">{formatUnits(pending, NOMA_DECIMALS)}</div>
      </div>
      <div className="bg-bg px-3 py-2">
        <div className="font-mono text-[0.7rem] text-ink-dim uppercase">claimable</div>
        <div className="tnum mt-0.5 font-mono">{usd(totalClaimableUsd)}</div>
      </div>
    </div>
  );
}

function StakeForm({
  staking,
  token,
  allowance,
  onDone,
}: {
  staking: `0x${string}`;
  token: `0x${string}`;
  allowance?: bigint;
  onDone: () => void;
}) {
  const [input, setInput] = useState("");
  const { writeContractAsync, isPending } = useWriteContract();

  const parsed = parseAmount(input);

  async function approve() {
    if (!parsed) return;
    try {
      await writeContractAsync({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [staking, parsed],
      });
      onDone();
    } catch {
      // user rejected or tx failed
    }
  }

  async function stake() {
    if (!parsed) return;
    try {
      await writeContractAsync({
        address: staking,
        abi: NOMA_STAKING_ABI,
        functionName: "stake",
        args: [parsed],
      });
      setInput("");
      onDone();
    } catch {
      // rejected
    }
  }

  const needsApprove = parsed != null && (allowance ?? 0n) < parsed;

  return (
    <div className="border border-line">
      <div className="border-b border-line px-3 py-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
        stake
      </div>
      <div className="p-3">
        <label htmlFor="stake-amount" className="field-label">
          amount
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="stake-amount"
            type="text"
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="amount in NOMA"
            className="field tnum min-w-0 flex-1"
          />
          <button
            type="button"
            disabled={!needsApprove || isPending}
            onClick={approve}
            className="border border-line px-3 py-2 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {isPending ? "…" : "approve"}
          </button>
          <button
            type="button"
            disabled={!parsed || needsApprove || isPending}
            onClick={stake}
            className="btn btn-sm"
          >
            stake
          </button>
        </div>
      </div>
      <p className="px-3 pb-2 font-mono text-[0.7rem] text-ink-dim">
        {needsApprove
          ? "approve first — staking pulls $NOMA from your wallet"
          : "staked $NOMA earns from the moment it is staked"}
      </p>
    </div>
  );
}

function UnstakeForm({
  staking,
  staked,
  onDone,
}: {
  staking: `0x${string}`;
  staked: bigint;
  onDone: () => void;
}) {
  const [input, setInput] = useState("");
  const { writeContractAsync, isPending } = useWriteContract();
  const parsed = parseAmount(input);

  async function unstake() {
    if (!parsed) return;
    try {
      await writeContractAsync({
        address: staking,
        abi: NOMA_STAKING_ABI,
        functionName: "requestUnstake",
        args: [parsed],
      });
      setInput("");
      onDone();
    } catch {
      // rejected
    }
  }

  return (
    <div className="border border-line">
      <div className="border-b border-line px-3 py-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
        unstake
      </div>
      <div className="p-3">
        <label htmlFor="unstake-amount" className="field-label">
          amount
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="unstake-amount"
            type="text"
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`up to ${formatUnits(staked, NOMA_DECIMALS)} NOMA`}
            className="field tnum min-w-0 flex-1"
          />
          <button
            type="button"
            disabled={!parsed || parsed > staked || isPending}
            onClick={unstake}
            className="border border-line px-4 py-2 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-40"
          >
            request unstake
          </button>
        </div>
      </div>
      <p className="px-3 pb-2 font-mono text-[0.7rem] text-ink-dim">
        stops earning immediately · withdrawable after the 7-day cooldown
      </p>
    </div>
  );
}

function WithdrawClaim({
  staking,
  position,
  onDone,
}: {
  staking: `0x${string}`;
  position?: Awaited<ReturnType<typeof getLookup>>;
  onDone: () => void;
}) {
  const { writeContractAsync, isPending } = useWriteContract();

  const now = useNow(30_000);
  const pending = position ? BigInt(position.pending_unstake) : 0n;
  const unlockAt = position?.unlock_at ? new Date(position.unlock_at).getTime() : 0;
  const canWithdraw = now != null && pending > 0n && unlockAt > 0 && now >= unlockAt;
  const claimable = position?.claimable ?? [];

  async function withdraw() {
    try {
      await writeContractAsync({
        address: staking,
        abi: NOMA_STAKING_ABI,
        functionName: "withdraw",
      });
      onDone();
    } catch {
      // rejected or cooldown active
    }
  }

  async function claimAll() {
    try {
      await writeContractAsync({
        address: staking,
        abi: NOMA_STAKING_ABI,
        functionName: "claimAll",
      });
      onDone();
    } catch {
      // rejected
    }
  }

  return (
    <div className="border border-line">
      <div className="border-b border-line px-3 py-2 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
        withdraw &amp; claim
      </div>
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          type="button"
          disabled={!canWithdraw || isPending}
          onClick={withdraw}
          className="border border-line px-4 py-2 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent disabled:opacity-40"
        >
          withdraw
        </button>
        <button
          type="button"
          disabled={claimable.length === 0 || isPending}
          onClick={claimAll}
          className="btn btn-sm"
        >
          claim all
        </button>
      </div>
      <div className="px-3 pb-2 font-mono text-[0.7rem] text-ink-dim">
        {pending > 0n && !canWithdraw && unlockAt > 0 ? (
          <span>
            unstake unlocks <Countdown to={position!.unlock_at!} doneLabel="now" />
          </span>
        ) : (
          <span>
            {claimable.length > 0
              ? claimable.map((c) => `${c.asset} ${amount(c.amount)}`).join(" · ")
              : "nothing claimable yet"}
          </span>
        )}
      </div>
    </div>
  );
}

function parseAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const v = parseUnits(trimmed, NOMA_DECIMALS);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
