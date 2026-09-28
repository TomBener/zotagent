import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import JSZip from "jszip";
import { parseHTML } from "linkedom";
import { domToMarkdown } from "./dom-markdown.js";
import { cleanText } from "./utils.js";

function xhtmlToMarkdown(html: string): string {
  const { document } = parseHTML(html);
  const body = document.querySelector("body");
  return body ? domToMarkdown(body as unknown as Node) : "";
}

// OPF documents may prefix their elements (`<opf:item>`), which a tag-name
// selector for `item` does not match.
function elementsByLocalName(root: Document, name: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter(
    (el) => el.tagName.toLowerCase().replace(/^[^:]*:/u, "") === name,
  );
}

// Manifest hrefs are URLs: percent-encoded (`ch%201.xhtml`, `%E7%AC%AC2.xhtml`)
// and possibly carrying a fragment. The zip holds the decoded names.
function hrefToZipPath(href: string, opfDir: string): string {
  const withoutFragment = href.replace(/#.*$/u, "");
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // A literal % in a file name: keep the href as written.
  }
  return resolve(`/${opfDir}`, decoded).slice(1);
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

  for (const item of elementsByLocalName(document as unknown as Document, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, hrefToZipPath(href, opfDir));
  }

  const spineItems: string[] = [];
  for (const itemref of elementsByLocalName(document as unknown as Document, "itemref")) {
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
