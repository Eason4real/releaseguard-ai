import type { IncidentCorpusType } from "../types";

export const PUBLIC_INCIDENT_INGESTION_VERSION = "public-incidents-v1";
export const PUBLIC_INCIDENT_SNAPSHOT_VERSION = "postmortems-app-snapshot-v1";
export const REAL_PUBLIC_CORPUS_VERSION = "real-public-postmortems-app-v1";

export type PublicIncidentSourceProvider = "POSTMORTEMS_APP";
export type OriginalRightsStatus = "KNOWN_LICENSE" | "SOURCE_SPECIFIC" | "UNKNOWN";

export type DatasetLicense = {
  provider: PublicIncidentSourceProvider;
  name: string;
  url: string;
};

export type OriginalContentRights = {
  status: OriginalRightsStatus;
  licenseName: string | null;
  licenseUrl: string | null;
  sourceUrl: string;
};

export type PostmortemsAppRecord = {
  UUID?: unknown;
  URL?: unknown;
  ArchiveURL?: unknown;
  Title?: unknown;
  StartTime?: unknown;
  EndTime?: unknown;
  Categories?: unknown;
  Keywords?: unknown;
  Company?: unknown;
  Product?: unknown;
  SourcePublishedAt?: unknown;
  SourceFetchedAt?: unknown;
  Summary?: unknown;
  Description?: unknown;
};

export type PublicIncidentSourceSnapshot = {
  sourceProvider: PublicIncidentSourceProvider;
  sourceRecordId: string;
  providerEndpoint: string;
  retrievedAt: string;
  sourcePayloadHash: string;
  snapshotVersion: string;
  etag: string | null;
  lastModified: string | null;
  payload: PostmortemsAppRecord;
};

export type PublicIncidentSnapshotFile = {
  snapshotVersion: string;
  sourceProvider: PublicIncidentSourceProvider;
  records: PublicIncidentSourceSnapshot[];
};

export type RealPublicIncident = {
  id: string;
  corpusType: Extract<IncidentCorpusType, "REAL_PUBLIC">;
  sourceProvider: PublicIncidentSourceProvider;
  title: string;
  company: string;
  incidentDateStart: string | null;
  incidentDateEnd: string | null;
  publishedAt: string | null;
  categories: string[];
  products: string[];
  sourceUrl: string;
  originalSourceUrl: string;
  datasetLicense: DatasetLicense;
  originalContentRights: OriginalContentRights;
  sourceRecordId: string;
  sourcePayloadHash: string;
  snapshotVersion: string;
  retrievedAt: string;
  contentHash: string;
  causeSummary: string | null;
  impactSummary: string | null;
  detectionSummary: string | null;
  mitigationSummary: string | null;
  resolutionSummary: string | null;
  lessonsSummary: string | null;
  sourceSummary: string | null;
  rawMetadata: Record<string, unknown>;
  ingestionVersion: string;
};

export type PublicIncidentManifestEntry = {
  sourceProvider: PublicIncidentSourceProvider;
  sourceId: string;
  title: string;
  company: string;
  sourceUrl: string;
  originalSourceUrl: string;
  datasetLicense: DatasetLicense;
  originalContentRights: OriginalContentRights;
  sourcePayloadHash: string;
  contentHash: string;
  snapshotVersion: string;
  ingestionStatus: "ACCEPTED" | "REJECTED" | "DUPLICATE";
};

export type PreparedPublicIncidentChunk = {
  id: string;
  documentId: string;
  incidentId: string;
  title: string;
  section: string;
  content: string;
  metadataJson: string;
  searchText: string;
  tokenCount: number;
  contentHash: string;
  corpusVersion: string;
  corpusType: "REAL_PUBLIC";
  embeddingModel: string;
  embeddingJson: string;
  terms: Array<{ term: string; termFrequency: number }>;
};

export type PreparedPublicIncident = {
  incident: RealPublicIncident;
  document: {
    id: string;
    incidentId: string;
    title: string;
    content: string;
    metadataJson: string;
    sourceDocument: string;
    corpusVersion: string;
    contentHash: string;
    corpusType: "REAL_PUBLIC";
    sourceProvider: PublicIncidentSourceProvider;
    sourceRecordId: string;
    sourceUrl: string;
    originalSourceUrl: string;
    datasetLicenseName: string;
    datasetLicenseUrl: string;
    originalRightsStatus: OriginalRightsStatus;
    originalLicenseName: string | null;
    originalLicenseUrl: string | null;
    sourcePayloadHash: string;
    snapshotVersion: string;
    indexStatus: "PENDING" | "ACTIVE";
    retrievedAt: string;
    ingestionVersion: string;
    createdAt: string;
  };
  chunks: PreparedPublicIncidentChunk[];
};

export interface PublicIncidentSource {
  readonly provider: PublicIncidentSourceProvider;
  fetchRecords(sourceRecordIds: string[]): Promise<PublicIncidentSourceSnapshot[]>;
  parse(input: unknown): PostmortemsAppRecord;
}

export type ImportAttemptStatus =
  | "PREPARING"
  | "PERSISTED"
  | "INDEX_PENDING"
  | "INDEXING"
  | "COMPLETED"
  | "INDEX_FAILED"
  | "FAILED";

export type ImportFailureStage = "SNAPSHOT" | "NORMALIZE" | "EMBEDDING" | "D1_PERSIST" | "VECTOR_INDEX" | "FINALIZE";

export type PublicIncidentImportAttempt = {
  id: string;
  provider: PublicIncidentSourceProvider;
  sourceRecordId: string;
  startedAt: string;
  completedAt: string | null;
  status: ImportAttemptStatus;
  documentId: string;
  contentHash: string;
  sourcePayloadHash: string;
  embeddingBackend: string;
  vectorBackend: string;
  failureStage: ImportFailureStage | null;
  failureCode: string | null;
  failureMessage: string | null;
  retryCount: number;
  ingestionVersion: string;
};

export type SourceIdentityDisposition =
  | "NEW"
  | "UNCHANGED"
  | "RETRY_PENDING"
  | "UPDATE_AVAILABLE"
  | "IDENTITY_CONFLICT"
  | "CANONICAL_URL_DUPLICATE"
  | "CONTENT_HASH_DUPLICATE";

export type SourceIdentityAssessment = {
  disposition: SourceIdentityDisposition;
  documentId: string | null;
  previousContentHash: string | null;
  previousIngestionVersion: string | null;
};

export type PublicIncidentRevision = {
  id: string;
  provider: PublicIncidentSourceProvider;
  sourceRecordId: string;
  documentId: string | null;
  status: "ACTIVE" | "UPDATE_AVAILABLE" | "IDENTITY_CONFLICT";
  previousContentHash: string | null;
  contentHash: string;
  sourcePayloadHash: string;
  previousIngestionVersion: string | null;
  ingestionVersion: string;
  sourceUrl: string;
  originalSourceUrl: string;
  detectedAt: string;
};

export type PublicIncidentImportFailure = {
  sourceRecordId: string | null;
  stage: ImportFailureStage;
  reasonCode: string;
  message: string;
};

export type PublicIncidentImportReport = {
  fetched: number;
  accepted: number;
  rejected: number;
  unchanged: number;
  updateAvailable: number;
  identityConflict: number;
  duplicate: number;
  persisted: number;
  indexed: number;
  completed: number;
  partial: number;
  failed: number;
  documents: number;
  chunks: number;
  dryRun: boolean;
  failures: PublicIncidentImportFailure[];
  rejections: Array<{ sourceRecordId: string | null; reason: string }>;
  duplicateDetails: Array<{ sourceRecordId: string; reason: string }>;
  updates: Array<{
    sourceRecordId: string;
    disposition: "UPDATE_AVAILABLE" | "IDENTITY_CONFLICT";
    previousContentHash: string | null;
    newContentHash: string;
    sourcePayloadHash: string;
  }>;
};
