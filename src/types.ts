export type SupportedFileType = "pdf" | "epub" | "html" | "txt" | "other";
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
  syncEnabled?: boolean;
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
  // Set only when keyword + qmd indexes have been rebuilt to match `entries`.
  // Absent on progress writes, so a crash mid-sync is detectable on restart.
  indexesCompletedAt?: string;
  // Effective qmd embedding model at the time indexes completed. Used to
  // invalidate the short-circuit when the model changes (different model =
  // different vector space, existing vectors are stale).
  indexedQmdEmbedModel?: string;
  // Stable signature of the zotagent/qmd/keyword indexer implementation used
  // to build the indexes. Any mismatch forces a rebuild even if files match.
  indexerSignature?: string;
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
  title: string;
  authors: string[];
  year?: string;
  passage: string;
  blockStart: number;
  blockEnd: number;
  score: number;
}

export type MetadataField = "title" | "author" | "year" | "abstract" | "journal" | "publisher";

export interface MetadataSearchResultRow {
  itemKey: string;
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

export interface DataPaths {
  logsDir: string;
  latestSyncLogPath: string;
  normalizedDir: string;
  manifestsDir: string;
  indexDir: string;
  keywordDbPath: string;
  tempDir: string;
  qmdDbPath: string;
  catalogPath: string;
}
