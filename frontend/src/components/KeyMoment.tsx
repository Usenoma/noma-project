"use client";

import { useState } from "react";

// The order-key block: shown once at checkout. Copy + save-to-file.
export function KeyMoment({ orderId, orderKey }: { orderId: string; orderKey: string }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(orderKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }

  function saveToFile() {
    const body = [
      `NOMA order ${orderId}`,
      ``,
      `order key: ${orderKey}`,
      ``,
      `This key is the only way back to this order.`,
      `Order page: ${window.location.origin}/order/${orderId}#k=${orderKey}`,
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `noma-order-${orderId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="border border-warn bg-bg-raised p-4">
      <div className="font-mono text-[0.7rem] tracking-widest text-warn uppercase">order key</div>
      <div className="tnum mt-2 overflow-x-auto border border-line bg-bg px-3 py-2 font-mono text-sm break-all whitespace-pre-wrap">
        {orderKey}
      </div>
      <p className="mt-3 text-sm text-ink-dim">
        This key is the only way back to this order. Save it.
      </p>
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          onClick={copy}
          className="border border-line px-3 py-1.5 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent"
        >
          {copied ? "copied" : "copy key"}
        </button>
        <button
          type="button"
          onClick={saveToFile}
          className="border border-line px-3 py-1.5 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent"
        >
          {saved ? "saved" : "save to file"}
        </button>
      </div>
    </div>
  );
}
