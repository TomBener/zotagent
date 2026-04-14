import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import JSZip from "jszip";
import { parseHTML } from "linkedom";
import { cleanText } from "./utils.js";

const BLOCK_TAGS = new Set([
  "p", "div", "blockquote", "section", "article", "aside", "header", "footer",
  "nav", "main", "figure", "figcaption", "details", "summary", "pre", "table",
  "ul", "ol", "dl", "hr", "address",
]);

function xhtmlToMarkdown(html: string): string {
  const { document } = parseHTML(html);
  const lines: string[] = [];
  let inline: string[] = [];

  function flushInline(): void {
    const text = inline.join("").trim();
    if (text) lines.push(text);
    inline = [];
  }

  function walk(node: Node): void {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (text.trim() || (text === " " && inline.length > 0)) inline.push(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const el = node as Element;
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
      for (const child of Array.from(node.childNodes)) walk(child);
      flushInline();
      if (lines.length > before) lines.push("");
      return;
    }

    for (const child of Array.from(node.childNodes)) walk(child);
  }

  const body = document.querySelector("body");
  if (body) walk(body);
  flushInline();

  return cleanText(lines.join("\n"));
}

function parseContainerXml(xml: string): string {
  const { document } = parseHTML(xml);
  const rootfile = document.querySelector("rootfile");
  const path = rootfile?.getAttribute("full-path");
  if (!path) throw new Error("EPUB container.xml missing rootfile full-path");
  return path;
}

function parseOpfSpine(opfXml: string, opfDir: string): string[] {
  const { document } = parseHTML(opfXml);
  const manifest = new Map<string, string>();

  for (const item of Array.from(document.querySelectorAll("item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, resolve(`/${opfDir}`, href).slice(1));
  }

  const spineItems: string[] = [];
  for (const itemref of Array.from(document.querySelectorAll("itemref"))) {
    const idref = itemref.getAttribute("idref");
    if (idref) {
      const href = manifest.get(idref);
      if (href) spineItems.push(href);
    }
  }

  return spineItems;
}

export async function extractEpub(filePath: string): Promise<string> {
  const data = readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("EPUB missing META-INF/container.xml");

  const opfPath = parseContainerXml(containerXml);
  const opfDir = dirname(opfPath);
  const opfXml = await zip.file(opfPath)?.async("string");
  if (!opfXml) throw new Error(`EPUB missing OPF file: ${opfPath}`);

  const spineItems = parseOpfSpine(opfXml, opfDir);
  if (spineItems.length === 0) throw new Error("EPUB spine is empty");

  const sections: string[] = [];
  for (const itemPath of spineItems) {
    const file = zip.file(itemPath);
    if (!file) continue;
    const xhtml = await file.async("string");
    const md = xhtmlToMarkdown(xhtml);
    if (md) sections.push(md);
  }

  return cleanText(sections.join("\n\n"));
}
