"use client";

import { useState } from "react";
import { useAccount, useBalance, useReadContract, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { formatUnits } from "viem";
import { ERC20_ABI, USDG_ADDRESS } from "@/lib/abi";
import { fromRaw } from "@/lib/format";
import { robinhoodChain } from "@/lib/wagmi";
import type { Invoice } from "@/lib/types";
import { WalletScope } from "./WalletScope";

function PayWithWallet({
  invoice,
  decimals,
  onPaid,
}: {
  invoice: Invoice;
  decimals: number;
  onPaid: () => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync, isPending: writing } = useWriteContract();
  const { sendTransactionAsync, isPending: sending } = useSendTransaction();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const { data: usdgBalance } = useReadContract({
    address: USDG_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && invoice.asset === "USDG" },
  });
  const { data: ethBalance } = useBalance({
    address,
    query: { enabled: !!address && invoice.asset === "ETH" },
  });

  if (!isConnected || !address) {
    return (
      <p className="text-center font-mono text-xs text-ink-dim">
        connect a wallet (top right) to pay from it — or send the exact amount above.
      </p>
    );
  }

  const needed = BigInt(invoice.amount);
  const balance = invoice.asset === "USDG" ? (usdgBalance as bigint | undefined) : ethBalance?.value;
  const insufficient = balance != null && balance < needed;
  const wrongChain = chainId !== robinhoodChain.id;
  const busy = writing || sending || switching;

  async function pay() {
    setError(null);
    setSent(false);
    try {
      if (invoice.asset === "USDG") {
        await writeContractAsync({
          address: USDG_ADDRESS,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [invoice.pay_to as `0x${string}`, needed],
        });
      } else {
        await sendTransactionAsync({
          to: invoice.pay_to as `0x${string}`,
          value: needed,
        });
      }
      setSent(true);
      onPaid();
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : "payment failed";
      setError(msg);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {wrongChain ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: robinhoodChain.id })}
          disabled={switching}
          className="w-full border border-warn px-4 py-3 font-mono text-sm tracking-widest text-warn uppercase hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {switching ? "switching…" : "switch to robinhood chain"}
        </button>
      ) : (
        <button type="button" onClick={pay} disabled={busy || insufficient} className="btn w-full">
          {busy ? "confirm in wallet…" : `pay ${fromRaw(invoice.amount, decimals)} ${invoice.asset} from wallet`}
        </button>
      )}
      <div className="flex items-baseline justify-between font-mono text-[0.7rem] text-ink-dim">
        <span>
          balance {balance != null ? `${formatUnits(balance, decimals)} ${invoice.asset}` : "—"}
        </span>
        {insufficient ? <span className="text-bad">insufficient balance</span> : null}
      </div>
      {sent ? <p className="font-mono text-xs text-ink-dim">payment sent — waiting for confirmation</p> : null}
      {error ? <p className="font-mono text-xs text-bad">{error}</p> : null}
    </div>
  );
}

/** Wallet payment button; wagmi/viem load only when this component is rendered (on click). */
export function PayButton(props: { invoice: Invoice; decimals: number; onPaid: () => void }) {
  return (
    <WalletScope>
      <PayWithWallet {...props} />
    </WalletScope>
  );
}
