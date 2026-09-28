import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { decodeHtmlBytes, domToMarkdown } from "./dom-markdown.js";
import { cleanText } from "./utils.js";

export async function extractHtml(filePath: string): Promise<string> {
  const raw = decodeHtmlBytes(readFileSync(filePath));
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
