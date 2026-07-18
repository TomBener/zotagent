// Pure mapping from external metadata shapes — CSL JSON (doi.org content
// negotiation), manual CLI fields — to Zotero item fields. No network, no
// config, no templates: everything here is directly unit-testable, and both
// the add pipeline and the lenient JSON input parser build on it.

export type ZoteroCreator = Record<string, string>;

const DOI_URL_PREFIX_RE = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu;
const DOI_VALID_RE = /^10\.\S+\/\S+$/iu;
const TAG_RE = /<[^>]+>/gu;

export function normalizeSpace(value: string): string {
  return value.replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

export function cleanDoi(rawDoi: string): string {
  const cleaned = decodeURIComponent(rawDoi || "")
    .trim()
    .replace(DOI_URL_PREFIX_RE, "")
    .replace(/\/+$/u, "");
  if (!cleaned || !DOI_VALID_RE.test(cleaned)) {
    throw new Error(`Invalid DOI: ${rawDoi}`);
  }
  return cleaned;
}

export function firstString(value: unknown): string {
  if (typeof value === "string") return normalizeSpace(value);
  if (!Array.isArray(value)) return "";
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSpace(entry);
    if (normalized) return normalized;
  }
  return "";
}

export function sanitizeAbstract(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeSpace(value.replace(TAG_RE, " "));
}

// Keys cover both the CSL 1.0 vocabulary (returned by some registrars) and the
// CrossRef work-type vocabulary that leaks into DOI content-negotiated CSL JSON
// (e.g. OUP returns "book-chapter", not the CSL "chapter"). Missing keys fall
// back to "document" in determineDoiItemType, so list both spellings.
export const CSL_TO_ZOTERO_ITEM_TYPE: Record<string, string> = {
  "article-journal": "journalArticle",
  "journal-article": "journalArticle",
  "paper-conference": "conferencePaper",
  "proceedings-article": "conferencePaper",
  chapter: "bookSection",
  "book-chapter": "bookSection",
  "book-part": "bookSection",
  "book-section": "bookSection",
  book: "book",
  "edited-book": "book",
  monograph: "book",
  "reference-book": "book",
  report: "report",
  thesis: "thesis",
  webpage: "webpage",
  "post-weblog": "webpage",
  "article-magazine": "magazineArticle",
  "article-newspaper": "newspaperArticle",
};

export function determineDoiItemType(cslJson: Record<string, unknown>): string {
  const cslType = firstString(cslJson.type);
  const publisher = firstString(cslJson.publisher).toLowerCase();
  const url = firstString(cslJson.URL).toLowerCase();
  const containerTitle = firstString(cslJson["container-title"]);
  if (cslType === "article" && (publisher === "arxiv" || url.includes("arxiv.org"))) {
    return "preprint";
  }
  if (cslType === "article" && containerTitle) {
    return "journalArticle";
  }
  return CSL_TO_ZOTERO_ITEM_TYPE[cslType] ?? "document";
}

export function extractTitle(cslJson: Record<string, unknown>): { fullTitle: string; shortTitle?: string } {
  const title = firstString(cslJson.title);
  const subtitle = firstString(cslJson.subtitle);
  const explicitShortTitle = firstString(cslJson["short-title"]);
  const fullTitle = title && subtitle ? `${title}: ${subtitle}` : title;
  if (!fullTitle) return { fullTitle: "" };
  if (explicitShortTitle) {
    return { fullTitle, shortTitle: explicitShortTitle };
  }
  if (title && subtitle) {
    return { fullTitle, shortTitle: title };
  }
  return { fullTitle };
}

// Subtitle separator. Fullwidth `：` is lenient (Chinese titles routinely
// write `标题：副标题` without spaces). Every ASCII separator (`:`, em dash
// `—`, en dash `–`, hyphen `-`) requires whitespace on at least one side so
// we don't slice up titles where the punctuation is part of a token —
// `E. coli O157:H7`, `COVID-19–related`, `long-term`, `10:30`. Only the FIRST
// match in the title is used.
const SUBTITLE_SEP_RE = /\s*：\s*|\s+[:—–]\s*|\s*[:—–]\s+|\s+-\s+/u;

/**
 * Pull the leading "main title" out of a title that uses a subtitle separator
 * (e.g. "Foo: Bar" → "Foo"). Returns undefined when there is no separator,
 * the prefix is empty, or there is nothing after the separator — there's no
 * point advertising a short title that's identical to the full title.
 */
export function deriveShortTitle(fullTitle: string): string | undefined {
  const trimmed = (fullTitle || "").trim();
  if (!trimmed) return undefined;
  const match = SUBTITLE_SEP_RE.exec(trimmed);
  if (!match || match.index === 0) return undefined;
  const candidate = trimmed.slice(0, match.index).trim();
  const remainder = trimmed.slice(match.index + match[0].length).trim();
  if (!candidate || !remainder || candidate === trimmed) return undefined;
  return candidate;
}

export function formatIssuedDate(issuedValue: unknown): string {
  if (!issuedValue || typeof issuedValue !== "object") return "";
  const dateParts = (issuedValue as { "date-parts"?: unknown[] })["date-parts"];
  if (!Array.isArray(dateParts) || dateParts.length === 0) return "";
  const firstPart = dateParts[0];
  if (!Array.isArray(firstPart) || firstPart.length === 0) return "";

  const cleanedParts: string[] = [];
  for (const part of firstPart.slice(0, 3)) {
    if (typeof part !== "number" || !Number.isInteger(part)) break;
    if (cleanedParts.length === 0) {
      cleanedParts.push(`${part}`.padStart(4, "0"));
    } else {
      cleanedParts.push(`${part}`.padStart(2, "0"));
    }
  }
  return cleanedParts.join("-");
}

function parseAuthorName(rawAuthor: string): ZoteroCreator | null {
  const author = normalizeSpace(rawAuthor);
  if (!author) return null;

  if (author.includes(",")) {
    const [lastName, firstName] = author.split(",", 2).map((value) => normalizeSpace(value));
    if (lastName || firstName) {
      const creator: ZoteroCreator = {
        creatorType: "author",
      };
      if (firstName) creator.firstName = firstName;
      if (lastName) creator.lastName = lastName;
      return creator;
    }
  }

  const parts = author.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return {
      creatorType: "author",
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts.at(-1)!,
    };
  }

  return {
    creatorType: "author",
    name: author,
  };
}

export function mapManualAuthors(authors: string[]): ZoteroCreator[] {
  return authors.map(parseAuthorName).filter((value): value is ZoteroCreator => value !== null);
}

export function mapCslAuthors(cslJson: Record<string, unknown>): ZoteroCreator[] {
  const authorList = Array.isArray(cslJson.author) ? cslJson.author : [];
  return authorList
    .map((author) => {
      if (!author || typeof author !== "object") return null;
      const family = normalizeSpace(String((author as { family?: unknown }).family || ""));
      const given = normalizeSpace(String((author as { given?: unknown }).given || ""));
      const literal = normalizeSpace(String((author as { literal?: unknown }).literal || ""));
      if (family || given) {
        const creator: ZoteroCreator = {
          creatorType: "author",
        };
        if (given) creator.firstName = given;
        if (family) creator.lastName = family;
        return creator;
      }
      if (literal) {
        return {
          creatorType: "author",
          name: literal,
        };
      }
      return null;
    })
    .filter((value): value is ZoteroCreator => value !== null);
}
