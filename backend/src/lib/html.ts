/**
 * Minimal HTML-to-text for the Ghost Agent's page fetches. Not a DOM parser: script/style and
 * other hidden blocks are dropped, tags become whitespace, entities are decoded and whitespace
 * collapses. Enough to hand a page's readable text to the LLM with no new dependency.
 */

const BLOCKS = /<(script|style|svg|noscript|template|iframe|head)[\s>][\s\S]*?<\/\1>/gi;

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&dollar;/gi, "$")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

export function extractText(html: string, maxChars: number): string {
  const text = decodeEntities(html.replace(BLOCKS, " "))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
