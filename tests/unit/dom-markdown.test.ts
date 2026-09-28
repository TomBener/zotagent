import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

import { decodeHtmlBytes, decodeTextBytes } from "../../src/dom-markdown.js";
import { extractEpub } from "../../src/epub.js";
import { extractHtml } from "../../src/html-extract.js";

async function writeEpub(dir: string, opf: string, files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file("OEBPS/content.opf", opf);
  for (const [name, body] of Object.entries(files)) zip.file(`OEBPS/${name}`, body);
  const path = join(dir, "book.epub");
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

const chapter = (body: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

test("extractEpub follows percent-encoded and prefixed manifest entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zotagent-epub-"));
  const opf = `<?xml version="1.0"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
  <opf:manifest>
    <opf:item id="c1" href="ch%201.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="c2" href="%E7%AC%AC2%E7%AB%A0.xhtml#start" media-type="application/xhtml+xml"/>
    <opf:item id="c3" href="three.xhtml" media-type="application/xhtml+xml"/>
  </opf:manifest>
  <opf:spine><opf:itemref idref="c1"/><opf:itemref idref="c2"/><opf:itemref idref="c3"/></opf:spine>
</opf:package>`;
  const path = await writeEpub(dir, opf, {
    "ch 1.xhtml": chapter("<p>Chapter one</p>"),
    "第2章.xhtml": chapter("<p>第二章正文</p>"),
    "three.xhtml": chapter("<p>Chapter three</p>"),
  });
  const text = await extractEpub(path);
  assert.match(text, /Chapter one[\s\S]*第二章正文[\s\S]*Chapter three/u);
});

test("extractEpub keeps table rows and cells apart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zotagent-epub-table-"));
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><manifest><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>`;
  const path = await writeEpub(dir, opf, {
    "t.xhtml": chapter("<table><tr><th>Year</th><th>Population</th></tr><tr><td>1850</td><td>4000</td></tr></table>"),
  });
  const text = await extractEpub(path);
  assert.match(text, /Year \| Population\n1850 \| 4000/u);
});

test("extractHtml decodes a page by its declared charset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zotagent-html-gbk-"));
  const html = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body><p>中国历史研究</p></body></html>';
  // Encode as GBK: TextEncoder only writes UTF-8, so map through a decoder table.
  const gbk = new Map<string, number[]>([["中", [0xd6, 0xd0]], ["国", [0xb9, 0xfa]], ["历", [0xc0, 0xfa]], ["史", [0xca, 0xb7]], ["研", [0xd1, 0xd0]], ["究", [0xbe, 0xbf]]]);
  const bytes = [...html].flatMap((ch) => gbk.get(ch) ?? [ch.charCodeAt(0)]);
  const path = join(dir, "page.html");
  writeFileSync(path, Buffer.from(bytes));
  assert.equal(new TextDecoder("gbk").decode(Buffer.from(gbk.get("中")!)), "中");
  assert.match(await extractHtml(path), /中国历史研究/u);
});

test("decodeHtmlBytes and decodeTextBytes honour a BOM and default to UTF-8", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>héllo</p>", "utf16le")]);
  assert.equal(decodeHtmlBytes(utf16), "<p>héllo</p>");
  assert.equal(decodeTextBytes(Buffer.from("﻿plain text", "utf-8")), "plain text");
  assert.equal(decodeHtmlBytes(Buffer.from("<meta charset=utf-16><p>ascii</p>")), "<meta charset=utf-16><p>ascii</p>");
  assert.equal(decodeHtmlBytes(Buffer.from("<p>no declaration, é</p>")), "<p>no declaration, é</p>");
});
