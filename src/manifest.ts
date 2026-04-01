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
