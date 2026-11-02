import { config } from "../../config.js";
import { extractText } from "../../lib/html.js";
import { assertSafeUrl } from "../../lib/ssrf.js";

/**
 * Ghost Browser: isolated stateless research. Every search/page fetch is server-side with no
 * cookie jar and no user identity, DNS resolves fresh per request, and every hop is SSRF-guarded.
 * Each action is written to the mission event trail (the Ghost Receipt data source).
 */

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export type MissionEventLogger = (kind: string, detail: Record<string, unknown>) => Promise<void>;

const UA = "Mozilla/5.0 (compatible; NOMA-Ghost/0.1; privacy research)";

/** Tavily search. Returns [] when unconfigured or the upstream fails; the caller explains. */
async function tavilySearch(query: string): Promise<SearchResult[]> {
  let data: { results?: { title?: string; url?: string; content?: string; score?: number }[] };
  const res = await fetch(`${config.TAVILY_BASE_URL.replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      query,
      max_results: config.GHOST_MAX_SEARCH_RESULTS,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(config.GHOST_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  data = (await res.json()) as typeof data;
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({ title: r.title!, url: r.url!, content: (r.content ?? "").slice(0, 800), score: r.score }));
}

/**
 * Keyless DuckDuckGo HTML search — the fallback so research works with no third-party key.
 * Parses the anon endpoint's result anchors (`uddg=` redirect links, titles, snippets).
 */
const DDG_RESULT = /<a[^>]*class="result__a"[^>]*href="[^"]*uddg=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
const DDG_SNIPPET = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

export function parseDdgHtml(html: string, maxResults: number): SearchResult[] {
  const links: string[] = [];
  const titles: string[] = [];
  let m: RegExpExecArray | null;
  DDG_RESULT.lastIndex = 0;
  while ((m = DDG_RESULT.exec(html)) !== null) {
    try {
      links.push(decodeURIComponent(m[1]!));
      titles.push(extractText(m[2]!, 300));
    } catch {
      // malformed uddg param — skip this result
    }
  }
  const snippets: string[] = [];
  DDG_SNIPPET.lastIndex = 0;
  while ((m = DDG_SNIPPET.exec(html)) !== null) snippets.push(extractText(m[1]!, 500));

  const results: SearchResult[] = [];
  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    results.push({
      title: titles[i] || links[i]!,
      url: links[i]!,
      content: snippets[i] ?? "",
    });
  }
  return results;
}

async function ddgSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { accept: "text/html,application/xhtml+xml", "user-agent": UA },
    signal: AbortSignal.timeout(config.GHOST_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer()).subarray(0, config.GHOST_FETCH_MAX_BYTES).toString("utf8");
  return parseDdgHtml(raw, config.GHOST_MAX_SEARCH_RESULTS);
}

/** Web search: Tavily when a key is configured, otherwise keyless DuckDuckGo. */
export async function searchWeb(query: string, log: MissionEventLogger): Promise<SearchResult[]> {
  let results: SearchResult[];
  let provider: string;
  try {
    if (config.TAVILY_API_KEY) {
      results = await tavilySearch(query);
      provider = "tavily";
    } else {
      results = await ddgSearch(query);
      provider = "duckduckgo";
    }
  } catch (err) {
    await log("search", { query, provider: config.TAVILY_API_KEY ? "tavily" : "duckduckgo", error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  await log("search", { query, provider, results: results.length, urls: results.map((r) => r.url) });
  return results;
}

const MAX_REDIRECTS = 3;

/** Fetch one public page and return its readable text. Empty string on any failure. */
export async function fetchPage(raw: string, log: MissionEventLogger): Promise<string> {
  let url: URL;
  try {
    url = await assertSafeUrl(raw);
  } catch (err) {
    await log("fetch", { url: raw, error: err instanceof Error ? err.message : String(err) });
    return "";
  }
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await fetch(url, {
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": UA },
        signal: AbortSignal.timeout(config.GHOST_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      await log("fetch", { url: url.toString(), error: err instanceof Error ? err.message : String(err) });
      return "";
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      try {
        url = await assertSafeUrl(new URL(location, url).toString());
      } catch (err) {
        await log("fetch", { url: url.toString(), error: `unsafe redirect: ${err instanceof Error ? err.message : err}` });
        return "";
      }
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    await log("fetch", { url: url.toString(), error: `status ${res?.status ?? "none"}` });
    return "";
  }
  // generous cap on the raw size before extraction; the extracted text is capped separately
  const rawBytes = Number(res.headers.get("content-length") ?? 0);
  if (rawBytes > config.GHOST_FETCH_MAX_BYTES * 4) {
    await log("fetch", { url: url.toString(), error: "too large" });
    return "";
  }
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    await log("fetch", { url: url.toString(), error: err instanceof Error ? err.message : String(err) });
    return "";
  }
  if (buf.byteLength > config.GHOST_FETCH_MAX_BYTES * 4) {
    await log("fetch", { url: url.toString(), error: "too large" });
    return "";
  }
  const text = extractText(new TextDecoder().decode(buf), config.GHOST_FETCH_MAX_CHARS);
  await log("fetch", { url: url.toString(), chars: text.length });
  return text;
}
