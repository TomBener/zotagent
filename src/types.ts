export type SupportedFileType = "pdf" | "epub" | "other";

export interface AppConfig {
  bibliographyJsonPath: string;
  attachmentsRoot: string;
  dataDir: string;
  qmdEmbedModel?: string;
  warnings: string[];
}

export interface BibliographyRecord {
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  type?: string;
  attachmentPaths: string[];
}

export interface AttachmentCatalogEntry {
  docKey: string;
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  type?: string;
  filePath: string;
  fileExt: SupportedFileType;
  exists: boolean;
  supported: boolean;
}

export interface ManifestBlock {
  blockIndex: number;
  sectionPath: string[];
  blockType: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
  bbox?: number[];
  charStart: number;
  charEnd: number;
  lineStart: number;
  lineEnd: number;
  isReferenceLike: boolean;
}

export interface AttachmentManifest {
  docKey: string;
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  filePath: string;
  normalizedPath: string;
  blocks: ManifestBlock[];
}

export interface CatalogEntry {
  docKey: string;
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  type?: string;
  filePath: string;
  fileExt: SupportedFileType;
  exists: boolean;
  supported: boolean;
  extractStatus: "ready" | "missing" | "unsupported" | "error";
  size: number | null;
  mtimeMs: number | null;
  sourceHash: string | null;
  lastIndexedAt: string | null;
  normalizedPath?: string;
  manifestPath?: string;
  error?: string;
}

export interface CatalogFile {
  version: 1;
  generatedAt: string;
  entries: CatalogEntry[];
}

export interface CatalogCounts {
  totalAttachments: number;
  supportedAttachments: number;
  readyAttachments: number;
  missingAttachments: number;
  unsupportedAttachments: number;
  errorAttachments: number;
}

export interface SyncStats extends CatalogCounts {
  totalRecords: number;
  indexedAttachments: number;
  updatedAttachments: number;
  skippedAttachments: number;
  removedAttachments: number;
}

export interface SearchResultRow {
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  year?: string;
  file: string;
  passage: string;
  blockStart: number;
  blockEnd: number;
  score: number;
}

export interface ReadBlock {
  blockIndex: number;
  blockType: string;
  sectionPath: string[];
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

export interface DataPaths {
  normalizedDir: string;
  manifestsDir: string;
  indexDir: string;
  tempDir: string;
  qmdDbPath: string;
  catalogPath: string;
}
