import { closeSync, openSync, readSync } from "node:fs";
import { spawnSync } from "node:child_process";

const IDENTITY_V_MARKER = Buffer.from("/Identity-V", "latin1");
const SCAN_CHUNK_SIZE = 1024 * 1024;
const SINGLE_CJK_WORD_THRESHOLD = 0.15;
const PDFTOTEXT_PAGE_SAMPLE = 3;
const PDFTOTEXT_TIMEOUT_MS = 30_000;
const PDFTOTEXT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const cache = new Map<string, boolean>();

// Stage 1: scan raw bytes for "/Identity-V". Cheap, used as a pre-filter
// before the more expensive layout check. False positives are common — modern
// Chinese DTP tools tend to register an Identity-V CMap on every CIDFont even
// when the actual text is rendered horizontally.
export function pdfBytesIndicateVerticalEncoding(filePath: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const overlap = IDENTITY_V_MARKER.length - 1;
    const buf = Buffer.allocUnsafe(SCAN_CHUNK_SIZE + overlap);
    let position = 0;
    let carry = 0;
    while (true) {
      const bytesRead = readSync(fd, buf, carry, SCAN_CHUNK_SIZE, position);
      if (bytesRead === 0) break;
      const total = carry + bytesRead;
      if (buf.subarray(0, total).indexOf(IDENTITY_V_MARKER) !== -1) {
        return true;
      }
      position += bytesRead;
      const carryStart = Math.max(0, total - overlap);
      carry = total - carryStart;
      if (carry > 0) {
        buf.copy(buf, 0, carryStart, total);
      }
    }
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

// Parse pdftotext -bbox output and return the fraction of "words" that are a
// single CJK character. Vertical-encoded PDFs emit each character as its own
// positioned word because the vertical CMap stores one glyph per code;
// horizontal text emits multi-character words from contiguous runs. On a real
// sample of zh/ja PDFs the ratio cleanly separates around 0.15 — true
// verticals score 0.18+, false positives score below 0.15.
export function singleCjkWordRatio(bboxXml: string): number {
  let single = 0;
  let total = 0;
  const re = /<word[^>]*>([^<]+)<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bboxXml)) !== null) {
    total++;
    const content = m[1]!;
    if (content.length === 1) {
      const cp = content.codePointAt(0)!;
      if (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff)
      ) {
        single++;
      }
    }
  }
  return total === 0 ? 0 : single / total;
}

// Stage 2: actually run pdftotext on a sample of middle pages and apply
// singleCjkWordRatio. Returns false (= "not vertical") if pdftotext is
// unavailable, the file can't be read, or the ratio is below threshold.
function pdfLayoutIsVertical(filePath: string): boolean {
  const info = spawnSync("pdfinfo", [filePath], {
    encoding: "utf8",
    timeout: PDFTOTEXT_TIMEOUT_MS,
  });
  if (info.status !== 0 || !info.stdout) return false;
  const pageMatch = info.stdout.match(/^Pages:\s+(\d+)/m);
  const pages = pageMatch ? parseInt(pageMatch[1]!, 10) : 0;
  if (pages === 0) return false;

  let from: number;
  let to: number;
  if (pages <= PDFTOTEXT_PAGE_SAMPLE) {
    from = 1;
    to = pages;
  } else {
    const mid = Math.floor(pages / 2);
    from = Math.max(1, mid);
    to = Math.min(pages, from + PDFTOTEXT_PAGE_SAMPLE - 1);
  }

  const text = spawnSync(
    "pdftotext",
    ["-bbox", "-f", String(from), "-l", String(to), filePath, "-"],
    {
      encoding: "utf8",
      timeout: PDFTOTEXT_TIMEOUT_MS,
      maxBuffer: PDFTOTEXT_MAX_OUTPUT_BYTES,
    },
  );
  if (text.status !== 0 || !text.stdout) return false;

  return singleCjkWordRatio(text.stdout) >= SINGLE_CJK_WORD_THRESHOLD;
}

// Stage 2 implementation is held behind a swappable reference so tests can
// inject a deterministic verdict for synthetic PDFs (which can never satisfy
// the real pdftotext-backed check because they aren't valid PDF documents).
const defaultLayoutVerifier = pdfLayoutIsVertical;
let layoutVerifier: (filePath: string) => boolean = defaultLayoutVerifier;

export function _setLayoutVerifierForTesting(
  fn: ((filePath: string) => boolean) | null,
): void {
  layoutVerifier = fn ?? defaultLayoutVerifier;
}

// Two-stage detector: cheap byte scan rules out 90%+ of typical libraries;
// remaining candidates go through pdftotext to confirm they actually render
// text vertically (single-character positioned words). Combined check is the
// signal sync uses to decide whether to pass --reading-order=off to ODL and
// whether to invalidate pre-fix cached manifests.
export function pdfHasVerticalText(filePath: string): boolean {
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;

  if (!pdfBytesIndicateVerticalEncoding(filePath)) {
    cache.set(filePath, false);
    return false;
  }

  const verdict = layoutVerifier(filePath);
  cache.set(filePath, verdict);
  return verdict;
}

export function clearPdfVerticalCache(): void {
  cache.clear();
}

export function pdfVerticalCacheSize(): number {
  return cache.size;
}
