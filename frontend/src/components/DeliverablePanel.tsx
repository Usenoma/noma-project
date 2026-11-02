"use client";

import type {
  ApiKeyPayload,
  Deliverable,
  EsimLpaPayload,
  GiftcardCodePayload,
  ProxyCredentialsPayload,
  VpsCredentialsPayload,
  VpnConfigPayload,
} from "@/lib/types";
import { dateOnly } from "@/lib/format";
import { AiUsage } from "./AiUsage";
import { FigureBox } from "./FigureBox";
import { MonoBlock } from "./MonoBlock";
import { QrBlock } from "./QrBlock";

export function DeliverablePanel({ deliverables }: { deliverables: Deliverable[] }) {
  return (
    <div className="flex flex-col gap-6">
      {deliverables.map((d, i) => (
        <FigureBox key={i} caption="fig. — your delivery">
          <DeliverableBody deliverable={d} />
          <p className="mt-4 border-t border-line pt-3 text-xs text-ink-dim">
            stored encrypted · shown to the order key or the paying wallet
          </p>
        </FigureBox>
      ))}
    </div>
  );
}

function DeliverableBody({ deliverable }: { deliverable: Deliverable }) {
  const p = deliverable.payload;
  switch (deliverable.type) {
    case "esim_lpa":
      return <EsimLpa payload={p as unknown as EsimLpaPayload} />;
    case "vps_credentials":
      return <VpsCredentials payload={p as unknown as VpsCredentialsPayload} />;
    case "vpn_config":
      return <VpnConfig payload={p as unknown as VpnConfigPayload} />;
    case "proxy_credentials":
      return <ProxyCredentials payload={p as unknown as ProxyCredentialsPayload} />;
    case "giftcard_code":
      return <GiftcardCode payload={p as unknown as GiftcardCodePayload} />;
    case "api_key":
      return <ApiKey payload={p as unknown as ApiKeyPayload} />;
    default:
      return (
        <pre className="overflow-x-auto font-mono text-xs text-ink-dim">
          {JSON.stringify(p, null, 2)}
        </pre>
      );
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0">
      <span className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">{label}</span>
      <MonoBlock value={value} />
    </div>
  );
}

function EsimLpa({ payload }: { payload: EsimLpaPayload }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-6">
        <QrBlock value={payload.lpa} size={200} />
        <div className="min-w-0 flex-1">
          <Row label="lpa" value={payload.lpa} />
          <Row label="iccid" value={payload.iccid} />
          {payload.apn ? <Row label="apn" value={payload.apn} /> : null}
          {payload.pin ? <Row label="pin" value={payload.pin} /> : null}
          {payload.puk ? <Row label="puk" value={payload.puk} /> : null}
          {payload.expires_at ? <Row label="expires" value={dateOnly(payload.expires_at)} /> : null}
          {payload.install_url ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
              <span className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
                install
              </span>
              <a
                href={payload.install_url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-accent hover:underline"
              >
                open supplier install link ↗
              </a>
            </div>
          ) : null}
        </div>
      </div>
      <ol className="list-decimal pl-5 text-sm text-ink-dim">
        <li>Open Settings → Cellular → Add eSIM</li>
        <li>Scan the QR code</li>
        <li>Activate on arrival — validity starts at first network attachment</li>
      </ol>
    </div>
  );
}

function VpsCredentials({ payload }: { payload: VpsCredentialsPayload }) {
  return (
    <div className="flex flex-col gap-1">
      <Row label="host" value={payload.ipv4} />
      <Row label="user" value={payload.username} />
      <Row label="password" value={payload.password} />
      <Row label="ssh" value={payload.ssh} />
      <Row label="expires" value={`${payload.expires_in_days} days`} />
      <p className="mt-3 text-xs text-ink-dim">
        the password was generated for this order; change it on first login. {payload.note}
      </p>
    </div>
  );
}

function downloadFile(name: string, body: string) {
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function VpnConfig({ payload }: { payload: VpnConfigPayload }) {
  return (
    <div className="flex flex-col gap-1">
      <Row label="username" value={payload.username} />
      <Row label="password" value={payload.password} />
      <Row label="server" value={payload.server} />
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => downloadFile(payload.openvpn.file_name, payload.openvpn.file_body)}
          className="border border-line px-4 py-2 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent"
        >
          download {payload.openvpn.file_name}
        </button>
        <button
          type="button"
          onClick={() => downloadFile(payload.wireguard.file_name, payload.wireguard.file_body)}
          className="border border-line px-4 py-2 font-mono text-xs tracking-widest uppercase hover:border-accent hover:text-accent"
        >
          download {payload.wireguard.file_name}
        </button>
      </div>
      <p className="mt-3 font-mono text-xs text-ink-dim">
        wireguard: <span className="text-ink">wg-quick up ./{payload.wireguard.file_name}</span>
      </p>
      {payload.note ? <p className="mt-2 text-xs text-ink-dim">{payload.note}</p> : null}
    </div>
  );
}

function ProxyCredentials({ payload }: { payload: ProxyCredentialsPayload }) {
  const curl = `curl -x http://${payload.username}:${payload.password}@${payload.host}:${payload.ports.http} https://example.com`;
  return (
    <div className="flex flex-col gap-1">
      <Row label="gateway" value={payload.host} />
      <Row label="http port" value={String(payload.ports.http)} />
      <Row label="socks5 port" value={String(payload.ports.socks5)} />
      <Row label="username" value={payload.username} />
      <Row label="password" value={payload.password} />
      <Row label="traffic" value={`${payload.traffic_gb} GB`} />
      <div className="mt-3">
        <div className="mb-1.5 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          example
        </div>
        <MonoBlock value={curl} className="w-full" />
      </div>
      {payload.note ? <p className="mt-3 text-xs text-ink-dim">{payload.note}</p> : null}
    </div>
  );
}

function GiftcardCode({ payload }: { payload: GiftcardCodePayload }) {
  const code = payload.code ?? "";
  return (
    <div className="flex flex-col gap-4">
      {code ? (
        <div className="tnum border border-line bg-bg px-4 py-4 text-center font-mono text-2xl tracking-widest">
          {code}
        </div>
      ) : (
        <pre className="overflow-x-auto font-mono text-xs text-ink-dim">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
      {code ? <MonoBlock value={code} label="copy" className="w-full justify-center" /> : null}
      {typeof payload.pin === "string" && payload.pin ? <Row label="pin" value={payload.pin} /> : null}
      {typeof payload.redemption_url === "string" && payload.redemption_url ? (
        <a
          href={payload.redemption_url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-xs text-accent hover:underline"
        >
          redeem ↗
        </a>
      ) : null}
    </div>
  );
}

function ApiKey({ payload }: { payload: ApiKeyPayload }) {
  const base = payload.base_url.replace(/\/$/, "");
  const model = payload.models?.[0] ?? "your-model";
  const revoked = Boolean(payload.revoked_at);
  const curl = `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${payload.api_key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`;
  const sdk = `from openai import OpenAI\n\nclient = OpenAI(\n  base_url="${base}",\n  api_key="${payload.api_key}",\n)\nprint(client.chat.completions.create(\n  model="${model}",\n  messages=[{"role": "user", "content": "hello"}],\n))`;
  return (
    <div className="flex flex-col gap-3">
      {revoked ? (
        <p className="border border-bad bg-bg px-3 py-2 font-mono text-xs text-bad">
          this API key was revoked. rotate it to get a new one; the remaining balance is kept.
        </p>
      ) : null}
      <Row label="api key" value={payload.api_key} />
      <Row label="base url" value={base} />
      {payload.credit_usd ? <Row label="purchased credit" value={`$${payload.credit_usd}`} /> : null}
      {payload.expires_at ? <Row label="expires" value={dateOnly(payload.expires_at)} /> : null}
      {payload.models?.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2">
          <span className="font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">models</span>
          <span className="font-mono text-xs text-ink-dim">{payload.models.join(" · ")}</span>
        </div>
      ) : null}
      <AiUsage payload={payload} revoked={revoked} />
      <div>
        <div className="mb-1.5 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          quickstart · curl
        </div>
        <CodeBlock code={curl} />
      </div>
      <div>
        <div className="mb-1.5 font-mono text-[0.7rem] tracking-widest text-ink-dim uppercase">
          quickstart · openai sdk
        </div>
        <CodeBlock code={sdk} />
      </div>
      <p className="mt-1 text-xs leading-5 text-ink-dim">
        This is a NOMA API key, not an OpenRouter key. Usage is billed at OpenRouter cost plus the platform
        fee; your balance is the amount you paid. Keep the key secret — expiry and revocation are enforced
        server-side.
        {payload.usage_url ? (
          <>
            {" "}Usage: <span className="font-mono text-ink">{payload.usage_url}</span>.
          </>
        ) : null}
      </p>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto border border-line bg-bg p-3 font-mono text-xs leading-5 text-ink-dim">
      {code}
    </pre>
  );
}
