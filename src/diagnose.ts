import { getDataPaths, resolveConfig, type ConfigOverrides } from "./config.js";
import { getReadyEntries, readCatalogFile } from "./state.js";
import type { CatalogEntry } from "./types.js";
import { compactHomePath, exists, readManifestFile } from "./utils.js";

export interface DiagnoseRow {
  itemKey: string;
  title: string;
  docKey: string;
  authors: string[];
  year?: string;
  filePath: string;
  normalizedPath?: string;
  blocks: number;
  avgChars: number;
  medianChars: number;
  status: "suspicious" | "borderline" | "ok";
  note?: string;
}

export interface DiagnoseSummary {
  totalDocsScanned: number;
  suspicious: number;
  borderline: number;
  ok: number;
  skipped: number;
}

export interface DiagnoseResult {
  summary: DiagnoseSummary;
  rows: DiagnoseRow[];
  warnings: string[];
}

export interface DiagnoseOptions {
  limit?: number;
  showAll?: boolean;
  thresholdAvg?: number;
  thresholdMedian?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_THRESHOLD_AVG = 15;
const DEFAULT_THRESHOLD_MEDIAN = 10;
const BORDERLINE_FACTOR = 1.5;

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function classify(
  avgChars: number,
  medianChars: number,
  thresholdAvg: number,
  thresholdMedian: number,
): { status: DiagnoseRow["status"]; note?: string } {
  if (avgChars < thresholdAvg || medianChars < thresholdMedian) {
    return {
      status: "suspicious",
      note:
        "Per-block text far below normal — extraction likely fragmented at the word or character level (often vertical CJK, scanned non-OCR PDFs, or multi-column gazetteers). Search ranking on this document is degraded.",
    };
  }
  if (
    avgChars < thresholdAvg * BORDERLINE_FACTOR
    || medianChars < thresholdMedian * BORDERLINE_FACTOR
  ) {
    return {
      status: "borderline",
      note: "Block lengths are below typical academic prose. Worth a manual check; may still be acceptable.",
    };
  }
  return { status: "ok" };
}

function buildRow(
  entry: CatalogEntry,
  textLengths: number[],
  thresholdAvg: number,
  thresholdMedian: number,
): DiagnoseRow {
  const blocks = textLengths.length;
  const sum = textLengths.reduce((acc, n) => acc + n, 0);
  const avg = blocks === 0 ? 0 : sum / blocks;
  const sorted = [...textLengths].sort((a, b) => a - b);
  const med = median(sorted);
  const { status, note } = classify(avg, med, thresholdAvg, thresholdMedian);
  const normalizedExists = entry.normalizedPath !== undefined && exists(entry.normalizedPath);
  return {
    itemKey: entry.itemKey,
    title: entry.title,
    docKey: entry.docKey,
    authors: entry.authors,
    ...(entry.year ? { year: entry.year } : {}),
    filePath: compactHomePath(entry.filePath),
    ...(normalizedExists ? { normalizedPath: compactHomePath(entry.normalizedPath!) } : {}),
    blocks,
    avgChars: Math.round(avg * 10) / 10,
    medianChars: Math.round(med * 10) / 10,
    status,
    ...(note ? { note } : {}),
  };
}

export async function diagnoseExtraction(
  options: DiagnoseOptions = {},
  overrides: ConfigOverrides = {},
): Promise<DiagnoseResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const showAll = options.showAll ?? false;
  const thresholdAvg = options.thresholdAvg ?? DEFAULT_THRESHOLD_AVG;
  const thresholdMedian = options.thresholdMedian ?? DEFAULT_THRESHOLD_MEDIAN;

  const config = resolveConfig(overrides);
  const paths = getDataPaths(config.dataDir);
  const catalog = readCatalogFile(paths.catalogPath);
  const readyEntries = getReadyEntries(catalog);

  const rows: DiagnoseRow[] = [];
  let skipped = 0;
  const summary: DiagnoseSummary = {
    totalDocsScanned: 0,
    suspicious: 0,
    borderline: 0,
    ok: 0,
    skipped: 0,
  };

  for (const entry of readyEntries) {
    if (!entry.manifestPath || !exists(entry.manifestPath)) {
      skipped += 1;
      continue;
    }
    let manifest;
    try {
      manifest = readManifestFile(entry.manifestPath);
    } catch {
      skipped += 1;
      continue;
    }
    const textLengths = manifest.blocks.map((b) => b.text.length).filter((n) => n > 0);
    if (textLengths.length === 0) {
      skipped += 1;
      continue;
    }
    summary.totalDocsScanned += 1;
    const row = buildRow(entry, textLengths, thresholdAvg, thresholdMedian);
    summary[row.status] += 1;
    rows.push(row);
  }
  summary.skipped = skipped;

  const filtered = showAll ? rows : rows.filter((r) => r.status !== "ok");
  filtered.sort((a, b) => b.blocks - a.blocks);
  const limited = filtered.slice(0, limit);

  return {
    summary,
    rows: limited,
    warnings: config.warnings,
  };
}
