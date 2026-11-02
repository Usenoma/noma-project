import { describe, expect, it, vi, afterEach } from "vitest";
import { lookup } from "node:dns/promises";
import { extractText } from "../src/lib/html.js";
import { isPrivateIp } from "../src/lib/ssrf.js";
import { aliasFor, generateAliases } from "../src/modules/ghost/profiles.js";
import { fetchPage, parseDdgHtml } from "../src/modules/ghost/research.js";
import { DEFAULT_RULES, evaluateRule } from "../src/modules/ghost/rules.js";
import { buildReceipt, type ReceiptEvent } from "../src/modules/ghost/service.js";
import { hashGhostKey, validGhostKey } from "../src/modules/ghost/vault.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const mockLookup = () => vi.mocked(lookup);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ssrf guard", () => {
  it("flags private, loopback, link-local and reserved ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "198.19.255.255",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "febf::1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("accepts public addresses and fails closed on unknown input", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
    expect(isPrivateIp("not-an-ip")).toBe(true);
  });
});

describe("html extraction", () => {
  it("drops hidden blocks, decodes entities and collapses whitespace", () => {
    const html = `
      <html><head><title>x</title></head><body>
        <script>alert("hi")</script>
        <style>.a { color: red }</style>
        <svg><path/></svg>
        <h1>Hello &amp; welcome&nbsp;back</h1>
        <p>  spaced   out </p>
        <p>quotes: &quot;a&quot; &#39;b&#39; &#x41;</p>
      </body></html>`;
    const text = extractText(html, 1000);
    expect(text).toContain("Hello & welcome back");
    expect(text).toContain(`quotes: "a" 'b' A`);
    expect(text).toContain("spaced out");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("<");
  });

  it("truncates to the requested size", () => {
    expect(extractText("<p>abcdefghij</p>", 5)).toBe("abcde…");
  });
});

describe("ghost profiles and rules", () => {
  it("generates synthetic aliases per profile", () => {
    const { email_alias, aliases } = generateAliases("abc123");
    expect(email_alias).toBe("ghost-abc123@noma.alias");
    expect(aliases).toEqual({
      name: "noma-ghost-abc123-name",
      phone: "noma-ghost-abc123-phone",
      address: "noma-ghost-abc123-address",
    });
    const profile = { id: "p1", name: "Primary", email_alias, aliases, active: true };
    expect(aliasFor(profile, "email")).toBe(email_alias);
    expect(aliasFor(profile, "phone")).toBe(aliases.phone);
    expect(aliasFor(profile, "wallet")).toBeNull();
    expect(aliasFor(null, "email")).toBeNull();
  });

  it("evaluates rules with deny as the fail-closed default", () => {
    expect(DEFAULT_RULES.email).toBe("alias");
    expect(DEFAULT_RULES.phone).toBe("deny");
    expect(evaluateRule(DEFAULT_RULES, "email")).toBe("alias");
    expect(evaluateRule(DEFAULT_RULES, "other")).toBe("deny");
    expect(evaluateRule({ ...DEFAULT_RULES, phone: "alias" }, "phone")).toBe("alias");
  });

  it("hashes vault keys and validates their shape", () => {
    const key = `noma_gv_${"a".repeat(43)}`;
    expect(hashGhostKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGhostKey(key)).toBe(hashGhostKey(key));
    expect(validGhostKey(key)).toBe(true);
    expect(validGhostKey("noma_gv_short")).toBe(false);
    expect(validGhostKey("noma_sk_abcdefghijklmnopqrstuvwxyz012345")).toBe(false);
    expect(validGhostKey("")).toBe(false);
  });
});

describe("ghost receipt builder", () => {
  const mission = { id: "m1", title: "VPS hunt", status: "done", created_at: new Date("2026-01-01T00:00:00Z") };

  it("derives sites, actions, permissions and shared info from the event trail", () => {
    const events: ReceiptEvent[] = [
      { kind: "search", detail: { query: "vps", urls: ["https://a.example", "https://b.example"] } },
      { kind: "fetch", detail: { url: "https://a.example" } },
      { kind: "fetch", detail: { url: "https://a.example" } },
      { kind: "fetch", detail: { url: "https://b.example" } },
      { kind: "permission_ask", detail: { field: "phone", reason: "signup" } },
      { kind: "permission_deny", detail: { field: "phone", by: "user" } },
      { kind: "permission_grant", detail: { field: "email", decision: "alias" } },
      { kind: "alias_used", detail: { field: "email", value: "ghost-abc@noma.alias" } },
      { kind: "data_shared", detail: { field: "name", value_kind: "real" } },
      {
        kind: "present",
        detail: { items: [{ name: "Provider A", price_usd: 5, privacy_note: "email only", url: "https://a.example", reason: "cheap" }] },
      },
      { kind: "purchase", detail: { order_id: "o1", title: "NOMA AI credits $5", price_usd: 5.4 } },
    ];
    const receipt = buildReceipt(mission, events);

    expect(receipt.sites_visited).toEqual(["https://a.example", "https://b.example"]);
    expect(receipt.actions).toEqual({ search: 1, fetch: 3, permission_ask: 1, permission_deny: 1, permission_grant: 1, alias_used: 1, data_shared: 1, present: 1, purchase: 1 });
    expect(receipt.permissions).toEqual([
      { field: "phone", decision: "deny" },
      { field: "email", decision: "alias" },
    ]);
    expect(receipt.info_shared.real).toEqual(["name"]);
    expect(receipt.info_shared.aliased).toEqual([{ field: "email", value: "ghost-abc@noma.alias" }]);
    expect(receipt.recommendations).toHaveLength(1);
    expect(receipt.recommendations[0]!.name).toBe("Provider A");
    expect(receipt.purchases).toEqual([{ order_id: "o1", title: "NOMA AI credits $5", price_usd: 5.4 }]);
    expect(receipt.title).toBe("VPS hunt");
  });

  it("reports an empty trail honestly", () => {
    const receipt = buildReceipt(mission, []);
    expect(receipt.sites_visited).toEqual([]);
    expect(receipt.actions).toEqual({});
    expect(receipt.info_shared).toEqual({ real: [], aliased: [] });
    expect(receipt.recommendations).toEqual([]);
    expect(receipt.purchases).toEqual([]);
  });
});

describe("duckduckgo fallback search", () => {
  it("parses result anchors, uddg links and snippets", () => {
    const html = `
      <div class="result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcheapvps.example%2Fplans&amp;rut=abc123">Cheap <b>VPS</b> plans</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcheapvps.example%2Fplans">From &amp;dollar;4/mo, email-only signup</a>
      </div>
      <div class="result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.example&amp;rut=def456">Other provider</a>
      </div>`;
    const results = parseDdgHtml(html, 5);
    expect(results).toEqual([
      { title: "Cheap VPS plans", url: "https://cheapvps.example/plans", content: "From $4/mo, email-only signup" },
      { title: "Other provider", url: "https://other.example", content: "" },
    ]);
  });

  it("caps results and skips malformed links", () => {
    const html = [1, 2, 3]
      .map(
        (i) =>
          `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fr${i}.example">R${i}</a>`,
      )
      .join("");
    expect(parseDdgHtml(html, 2)).toHaveLength(2);
    expect(parseDdgHtml('<a class="result__a" href="/no-uddg">x</a>', 5)).toEqual([]);
  });
});

describe("ghost page fetch (isolated, SSRF-guarded)", () => {
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  const log = async (kind: string, detail: Record<string, unknown>) => {
    events.push({ kind, detail });
  };

  it("fetches a public page and returns its readable text", async () => {
    mockLookup().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><body><script>x</script><h1>Plans from $4/mo</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "70" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchPage("https://example.com/plans", log);
    expect(text).toBe("Plans from $4/mo");
    expect(events.at(-1)).toEqual({ kind: "fetch", detail: { url: "https://example.com/plans", chars: 16 } });
  });

  it("refuses hosts that resolve to private addresses without fetching them", async () => {
    mockLookup().mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchPage("http://10.0.0.1/secret", log);
    expect(text).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      kind: "fetch",
      detail: { url: "http://10.0.0.1/secret", error: expect.stringContaining("non-public") },
    });
  });

  it("re-checks every redirect hop", async () => {
    mockLookup()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "192.168.1.1", family: 4 }]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await fetchPage("https://example.com/redirect", log);
    expect(text).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({
      kind: "fetch",
      detail: { url: "https://example.com/redirect", error: expect.stringContaining("unsafe redirect") },
    });
  });
});
