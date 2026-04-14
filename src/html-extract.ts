import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { cleanText } from "./utils.js";

const BLOCK_TAGS = new Set([
  "p", "div", "blockquote", "section", "article", "aside", "header", "footer",
  "nav", "main", "figure", "figcaption", "details", "summary", "pre", "table",
  "ul", "ol", "dl", "hr", "address",
]);

function domToMarkdown(node: Node): string {
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

    if (BLOCK_TAGS.has(tag)) {
      flushInline();
      const before = lines.length;
      for (const child of Array.from(n.childNodes)) walk(child);
      flushInline();
      if (lines.length > before) lines.push("");
      return;
    }

    for (const child of Array.from(n.childNodes)) walk(child);
  }

  walk(node);
  flushInline();
  return cleanText(lines.join("\n"));
}

export async function extractHtml(filePath: string): Promise<string> {
  const raw = readFileSync(filePath, "utf-8");
  const { document } = parseHTML(raw);

  const reader = new Readability(document as unknown as Document, {
    serializer: (node) => domToMarkdown(node as unknown as Node),
  });
  const article = reader.parse();

  if (article?.content) {
    const markdown = cleanText(article.content);
    if (markdown) return markdown;
  }

  const { document: fallbackDoc } = parseHTML(raw);
  const body = fallbackDoc.querySelector("body");
  if (!body) return "";
  return domToMarkdown(body as unknown as Node);
}
