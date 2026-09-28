// DOM → plain Markdown for the in-process extractors (EPUB chapters and
// saved HTML pages), shared so the two cannot drift. Headings, list items,
// and block elements become their own lines; table rows become one line
// each with cells separated, so a table reads as rows instead of one
// run-together string ("YearPopulation18504000").
import { cleanText } from "./utils.js";

const BLOCK_TAGS = new Set([
  "p", "div", "blockquote", "section", "article", "aside", "header", "footer",
  "nav", "main", "figure", "figcaption", "details", "summary", "pre", "table",
  "ul", "ol", "dl", "hr", "address", "tr", "caption",
]);
const CELL_TAGS = new Set(["td", "th"]);

export function domToMarkdown(node: Node): string {
  const lines: string[] = [];
  let inline: string[] = [];

  function flushInline(): void {
    const text = inline.join("").trim();
    if (text) lines.push(text);
    inline = [];
  }

  function walk(n: Node): void {
    if (n.nodeType === 3) {
      const text = (n.textContent ?? "").replace(/\s+/g, " ");
      if (text.trim() || (text === " " && inline.length > 0)) inline.push(text);
      return;
    }
    if (n.nodeType !== 1) return;

    const el = n as Element;
    const tag = el.tagName?.toLowerCase() ?? "";

    if (tag === "script" || tag === "style") return;

    const headingMatch = tag.match(/^h([1-6])$/);
    if (headingMatch) {
      flushInline();
      const level = Number(headingMatch[1]);
      const text = (el.textContent ?? "").trim();
      if (text) lines.push(`\n${"#".repeat(level)} ${text}\n`);
      return;
    }

    if (tag === "li") {
      flushInline();
      const text = (el.textContent ?? "").trim();
      if (text) lines.push(`- ${text}`);
      return;
    }

    if (tag === "br") {
      flushInline();
      lines.push("");
      return;
    }

    if (CELL_TAGS.has(tag)) {
      if (inline.length > 0) inline.push(" | ");
      for (const child of Array.from(n.childNodes)) walk(child);
      return;
    }

    if (BLOCK_TAGS.has(tag)) {
      flushInline();
      const before = lines.length;
      for (const child of Array.from(n.childNodes)) walk(child);
      flushInline();
      if (lines.length > before && tag !== "tr") lines.push("");
      return;
    }

    for (const child of Array.from(n.childNodes)) walk(child);
  }

  walk(node);
  flushInline();
  return cleanText(lines.join("\n"));
}

// Charset declared in the first bytes of an HTML document, per the HTML
// prescan: a BOM, `<meta charset>`, or `<meta http-equiv=Content-Type>`.
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/iu;

/** Decode an HTML file's bytes by its BOM or declared charset, falling back
 *  to UTF-8. Saved pages from older Chinese sites are routinely GBK/GB2312
 *  and turn to mojibake when read as UTF-8. */
export function decodeHtmlBytes(bytes: Uint8Array): string {
  const bomEncoding = encodingFromBom(bytes);
  if (bomEncoding) return new TextDecoder(bomEncoding).decode(bytes);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const declared = META_CHARSET_RE.exec(head)?.[1];
  // A meta tag read by an ASCII prescan cannot mean UTF-16 (the HTML spec
  // maps that declaration to UTF-8), so it only ever names 8-bit encodings.
  if (declared && !/^utf-16/iu.test(declared)) {
    try {
      return new TextDecoder(declared.toLowerCase()).decode(bytes);
    } catch {
      // An unknown label: fall through to UTF-8 like a browser would.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Decode a plain-text file by its BOM, else as UTF-8. */
export function decodeTextBytes(bytes: Uint8Array): string {
  return new TextDecoder(encodingFromBom(bytes) ?? "utf-8").decode(bytes);
}

function encodingFromBom(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return undefined;
}
