const REFERENCE_SECTION_RE =
  /\b(references|bibliography|works cited|literature cited|reference list)\b|参考文献/i;

const CITATION_START_RE =
  /^[\p{L}\p{M}'’.-]+,\s+(?:[\p{Lu}][\p{L}\p{M}'’.-]*|\p{Lu}\.)[\s\S]{0,120}\(\d{4}[a-z]?\)/u;

const BOILERPLATE_RE =
  /\b(to cite (?:this|the) (?:article|paper)|please cite|recommended citation|citation\s*:|downloaded from|all rights reserved|copyright|creative commons|author manuscript|accepted manuscript|published online|supplementary material|supporting information|correspondence (?:to|should be addressed to)|preprint\b|this version posted)\b/i;

const TABLE_OF_CONTENTS_RE =
  /^(contents|table of contents)$/i;

const DOT_LEADER_RE =
  /(?:^|[\s\S]{4,})\.{4,}\s*\d+\s*$/u;

export function isReferenceLikeSectionPath(sectionPath: string[]): boolean {
  return REFERENCE_SECTION_RE.test(sectionPath.join(" / "));
}

export function isReferenceLikeText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return false;
  if (/(available at|retrieved from|doi\s*:|https?:\/\/)/i.test(compact)) return true;
  if (CITATION_START_RE.test(compact)) return true;
  if (
    /\(\d{4}[a-z]?\)/.test(compact) &&
    /journal|press|vol\.|pp\.|isbn|issn|conference|proceedings/i.test(compact)
  ) {
    return true;
  }
  return false;
}

export function isReferenceLikeBlock(input: {
  text: string;
  sectionPath: string[];
  blockType?: string;
}): boolean {
  if (isReferenceLikeSectionPath(input.sectionPath)) return true;
  if (input.blockType === "list item" && isReferenceLikeText(input.text)) return true;
  return isReferenceLikeText(input.text);
}

export function isBoilerplateLikeText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return false;
  if (BOILERPLATE_RE.test(compact)) return true;
  if (TABLE_OF_CONTENTS_RE.test(compact)) return true;
  if (/^page \d+ of \d+$/i.test(compact)) return true;
  return false;
}

export function isTableOfContentsLikeText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return false;
  return DOT_LEADER_RE.test(compact);
}
