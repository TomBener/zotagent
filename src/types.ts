export type SupportedFileType = "pdf" | "epub" | "html" | "other";
export type ZoteroLibraryType = "user" | "group";

export interface AppConfig {
  bibliographyJsonPath: string;
  attachmentsRoot: string;
  dataDir: string;
  qmdEmbedModel?: string;
  semanticScholarApiKey?: string;
  zoteroLibraryId?: string;
  zoteroLibraryType?: ZoteroLibraryType;
  zoteroCollectionKey?: string;
  zoteroApiKey?: string;
  warnings: string[];
}

export interface SemanticScholarSearchResultRow {
  paperId: string;
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
  venue?: string;
  journal?: string;
  publicationDate?: string;
  publicationTypes: string[];
  url?: string;
  openAccessPdfUrl?: string;
  abstract?: string;
}

export interface SemanticScholarPaper extends SemanticScholarSearchResultRow {
}

export interface BibliographyRecord {
  itemKey: string;
  citationKey?: string;
  title: string;
  authors: string[];
  authorSearchTexts: string[];
  year?: string;
  abstract?: string;
  journal?: string;
  publisher?: string;
  type?: string;
  attachmentPaths: string[];
  supportedFiles: string[];
  hasSupportedFile: boolean;
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

export type MetadataField = "title" | "author" | "year" | "abstract" | "journal" | "publisher";

export interface MetadataSearchResultRow {
  itemKey: string;
  citationKey?: string;
  type?: string;
  title: string;
  authors: string[];
  year?: string;
  abstract?: string;
  hasSupportedFile: boolean;
  supportedFiles: string[];
  matchedFields: MetadataField[];
  score: number;
  journal?: string;
  publisher?: string;
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
  logsDir: string;
  latestSyncLogPath: string;
  normalizedDir: string;
  manifestsDir: string;
  indexDir: string;
  exactDbPath: string;
  tempDir: string;
  qmdDbPath: string;
  catalogPath: string;
}
