import { basename as pathBasename } from "node:path";

import type { AttachmentCatalogEntry, AttachmentManifest, ManifestBlock } from "./types.js";
import { isReferenceLikeBlock } from "./heuristics.js";
import { cleanText } from "./utils.js";

interface PdfElement {
  type: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
  bbox?: number[];
  headingLevel?: number;
}

interface DraftBlock {
  sectionPath: string[];
  blockType: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
  bbox?: number[];
  headingLevel?: number;
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number") return String(value);
  return undefined;
}

function collectPdfElements(input: unknown, out: PdfElement[]): void {
  if (Array.isArray(input)) {
    for (const value of input) collectPdfElements(value, out);
    return;
  }
  if (!input || typeof input !== "object") return;

  const record = input as Record<string, unknown>;
  const type = textFromUnknown(record.type);
  const content =
    textFromUnknown(record.content) ??
    textFromUnknown(record.description) ??
    textFromUnknown(record.text);

  if (type && content && content.length > 0) {
    const page = record["page number"];
    const headingLevel =
      typeof record["heading level"] === "number"
        ? record["heading level"]
        : typeof record.level === "number"
          ? record.level
          : undefined;
    const bbox = Array.isArray(record["bounding box"])
      ? (record["bounding box"].filter((value) => typeof value === "number") as number[])
      : undefined;
    out.push({
      type: type.toLowerCase(),
      text: content,
      pageStart: typeof page === "number" ? page : undefined,
      pageEnd: typeof page === "number" ? page : undefined,
      bbox: bbox && bbox.length > 0 ? bbox : undefined,
      headingLevel,
    });
  }

  for (const value of Object.values(record)) {
    if (typeof value === "object") {
      collectPdfElements(value, out);
    }
  }
}

function splitMarkdownToDraftBlocks(markdown: string): DraftBlock[] {
  const lines = cleanText(markdown).split("\n");
  const out: DraftBlock[] = [];
  const sectionStack: string[] = [];
  let paragraph: string[] = [];

  function flushParagraph(): void {
    const text = cleanText(paragraph.join("\n"));
    if (!text) return;
    out.push({
      sectionPath: [...sectionStack],
      blockType: "paragraph",
      text,
    });
    paragraph = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const text = cleanText(headingMatch[2]);
      sectionStack.splice(level - 1);
      sectionStack[level - 1] = text;
      out.push({
        sectionPath: [...sectionStack],
        blockType: "heading",
        text,
        headingLevel: level,
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  return out;
}

function toDraftBlocksFromJson(rawJson: string): DraftBlock[] {
  const elements: PdfElement[] = [];
  collectPdfElements(JSON.parse(rawJson), elements);
  const out: DraftBlock[] = [];
  const sectionStack: string[] = [];

  for (const element of elements) {
    const text = cleanText(element.text);
    if (!text) continue;

    if (element.type.includes("heading")) {
      const level = Math.max(1, Math.min(6, element.headingLevel || 1));
      sectionStack.splice(level - 1);
      sectionStack[level - 1] = text;
      out.push({
        sectionPath: [...sectionStack],
        blockType: "heading",
        text,
        pageStart: element.pageStart,
        pageEnd: element.pageEnd,
        bbox: element.bbox,
        headingLevel: level,
      });
      continue;
    }

    const blockType = element.type.includes("list") ? "list item" : element.type;
    out.push({
      sectionPath: [...sectionStack],
      blockType,
      text,
      pageStart: element.pageStart,
      pageEnd: element.pageEnd,
      bbox: element.bbox,
    });
  }

  return out;
}

function renderBlockMarkdown(block: DraftBlock): string {
  if (block.blockType === "heading") {
    const level = Math.max(1, Math.min(6, block.headingLevel || block.sectionPath.length || 1));
    return `${"#".repeat(level)} ${block.text}`;
  }
  if (block.blockType === "list item") {
    return `- ${block.text}`;
  }
  return block.text;
}

function annotateBlocks(draftBlocks: DraftBlock[]): { markdown: string; blocks: ManifestBlock[] } {
  let markdown = "";
  let line = 1;
  const blocks: ManifestBlock[] = [];

  for (const draft of draftBlocks) {
    const snippet = renderBlockMarkdown(draft).trim();
    if (!snippet) continue;

    if (markdown.length > 0) {
      markdown += "\n\n";
      line += 2;
    }

    const charStart = markdown.length;
    const lineStart = line;
    markdown += snippet;
    const charEnd = markdown.length;
    const lineEnd = lineStart + (snippet.match(/\n/g)?.length ?? 0);
    line = lineEnd;

    blocks.push({
      blockIndex: blocks.length,
      sectionPath: [...draft.sectionPath],
      blockType: draft.blockType,
      text: draft.text,
      pageStart: draft.pageStart,
      pageEnd: draft.pageEnd,
      bbox: draft.bbox,
      charStart,
      charEnd,
      lineStart,
      lineEnd,
      isReferenceLike: isReferenceLikeBlock({
        text: draft.text,
        sectionPath: draft.sectionPath,
        blockType: draft.blockType,
      }),
    });
  }

  return { markdown, blocks };
}

export function buildMarkdownManifest(
  attachment: AttachmentCatalogEntry,
  markdown: string,
  normalizedPath: string,
): { manifest: AttachmentManifest; markdown: string } {
  const draftBlocks = splitMarkdownToDraftBlocks(markdown);
  const annotated = annotateBlocks(draftBlocks);
  return {
    markdown: annotated.markdown,
    manifest: {
      docKey: attachment.docKey,
      itemKey: attachment.itemKey,
      ...(attachment.citationKey ? { citationKey: attachment.citationKey } : {}),
      title: attachment.title,
      authors: attachment.authors,
      ...(attachment.year ? { year: attachment.year } : {}),
      ...(attachment.abstract ? { abstract: attachment.abstract } : {}),
      filePath: attachment.filePath,
      normalizedPath,
      blocks: annotated.blocks,
    },
  };
}

interface MergeCursor {
  char: number;
  line: number;
  blockIndex: number;
  firstBlock: boolean;
}

function appendMergedBlock(
  source: ManifestBlock,
  cursor: MergeCursor,
  out: ManifestBlock[],
): void {
  if (!cursor.firstBlock) {
    cursor.char += 2;
    cursor.line += 2;
  }
  cursor.firstBlock = false;

  const width = source.charEnd - source.charStart;
  const heightInLines = source.lineEnd - source.lineStart;
  const merged: ManifestBlock = {
    blockIndex: cursor.blockIndex,
    sectionPath: [...source.sectionPath],
    blockType: source.blockType,
    text: source.text,
    ...(source.pageStart !== undefined ? { pageStart: source.pageStart } : {}),
    ...(source.pageEnd !== undefined ? { pageEnd: source.pageEnd } : {}),
    ...(source.bbox ? { bbox: [...source.bbox] } : {}),
    charStart: cursor.char,
    charEnd: cursor.char + width,
    lineStart: cursor.line,
    lineEnd: cursor.line + heightInLines,
    isReferenceLike: source.isReferenceLike,
  };

  out.push(merged);
  cursor.char += width;
  cursor.line += heightInLines;
  cursor.blockIndex += 1;
}

function makeSeparatorBlock(filePath: string): ManifestBlock {
  const basename = pathBasename(filePath) || "attachment";
  const text = `Attachment: ${basename}`;
  const snippet = `# ${text}`;
  return {
    blockIndex: 0,
    sectionPath: [text],
    blockType: "heading",
    text,
    charStart: 0,
    charEnd: snippet.length,
    lineStart: 1,
    lineEnd: 1,
    isReferenceLike: false,
  };
}

export function mergeManifestsForItem(manifests: AttachmentManifest[]): AttachmentManifest {
  if (manifests.length === 0) {
    throw new Error("mergeManifestsForItem requires at least one manifest");
  }
  if (manifests.length === 1) {
    return manifests[0]!;
  }

  const primary = manifests[0]!;
  const blocks: ManifestBlock[] = [];
  const cursor: MergeCursor = { char: 0, line: 1, blockIndex: 0, firstBlock: true };

  for (let i = 0; i < manifests.length; i += 1) {
    const source = manifests[i]!;
    if (i > 0) {
      appendMergedBlock(makeSeparatorBlock(source.filePath), cursor, blocks);
    }
    for (const block of source.blocks) {
      appendMergedBlock(block, cursor, blocks);
    }
  }

  return {
    docKey: `item:${primary.itemKey}`,
    itemKey: primary.itemKey,
    ...(primary.citationKey ? { citationKey: primary.citationKey } : {}),
    title: primary.title,
    authors: primary.authors,
    ...(primary.year ? { year: primary.year } : {}),
    ...(primary.abstract ? { abstract: primary.abstract } : {}),
    filePath: "",
    normalizedPath: "",
    blocks,
  };
}

export function buildPdfManifest(
  attachment: AttachmentCatalogEntry,
  markdown: string,
  rawJson: string,
  normalizedPath: string,
): { manifest: AttachmentManifest; markdown: string } {
  let draftBlocks: DraftBlock[] = [];
  try {
    draftBlocks = toDraftBlocksFromJson(rawJson);
  } catch {
    draftBlocks = [];
  }

  if (draftBlocks.length === 0) {
    draftBlocks = splitMarkdownToDraftBlocks(markdown);
  }

  const annotated = annotateBlocks(draftBlocks);
  return {
    markdown: annotated.markdown,
    manifest: {
      docKey: attachment.docKey,
      itemKey: attachment.itemKey,
      ...(attachment.citationKey ? { citationKey: attachment.citationKey } : {}),
      title: attachment.title,
      authors: attachment.authors,
      ...(attachment.year ? { year: attachment.year } : {}),
      ...(attachment.abstract ? { abstract: attachment.abstract } : {}),
      filePath: attachment.filePath,
      normalizedPath,
      blocks: annotated.blocks,
    },
  };
}
