import {
  PUBLIC_INCIDENT_INGESTION_VERSION,
  type PostmortemsAppRecord,
  type PublicIncidentSourceSnapshot,
  type RealPublicIncident,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ZERO_DATE = "0001-01-01T00:00:00Z";
const DATASET_LICENSE = {
  provider: "POSTMORTEMS_APP" as const,
  name: "GPL-3.0",
  url: "https://github.com/icco/postmortems/blob/main/LICENSE",
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right))
  : [];

const normalizedDate = (value: unknown) => {
  const candidate = text(value);
  if (!candidate || candidate === ZERO_DATE || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
};

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const canonicalizeUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("INVALID_SOURCE_URL");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  const parameters = [...url.searchParams.entries()]
    .filter(([key]) => !/^utm_/i.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, parameterValue] of parameters) url.searchParams.append(key, parameterValue);
  return url.toString();
};

export const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
};

export const hashSourcePayload = (payload: PostmortemsAppRecord) => sha256(canonicalJson(payload));

const stableContent = (value: Omit<RealPublicIncident, "contentHash" | "retrievedAt">) => canonicalJson({
  title: value.title,
  company: value.company,
  incidentDateStart: value.incidentDateStart,
  incidentDateEnd: value.incidentDateEnd,
  publishedAt: value.publishedAt,
  categories: [...value.categories].sort(),
  products: [...value.products].sort(),
  sourceSummary: value.sourceSummary,
});

export async function normalizePostmortemsAppRecord(
  snapshot: PublicIncidentSourceSnapshot,
): Promise<RealPublicIncident> {
  if (snapshot.sourceProvider !== "POSTMORTEMS_APP") throw new Error("INVALID_SOURCE_PROVIDER");
  if (!Number.isFinite(Date.parse(snapshot.retrievedAt))) throw new Error("INVALID_RETRIEVED_AT");
  const computedPayloadHash = await hashSourcePayload(snapshot.payload);
  if (computedPayloadHash !== snapshot.sourcePayloadHash) throw new Error("SOURCE_PAYLOAD_HASH_MISMATCH");

  const record = snapshot.payload;
  const sourceRecordId = text(record.UUID);
  const title = text(record.Title);
  const company = text(record.Company);
  const originalUrl = text(record.URL);
  if (!UUID_PATTERN.test(sourceRecordId) || sourceRecordId !== snapshot.sourceRecordId) {
    throw new Error("INVALID_SOURCE_RECORD_ID");
  }
  if (!title) throw new Error("MISSING_TITLE");
  if (!company) throw new Error("MISSING_COMPANY");
  if (!originalUrl) throw new Error("MISSING_SOURCE_URL");

  const originalSourceUrl = canonicalizeUrl(originalUrl);
  const products = text(record.Product) ? [text(record.Product)] : [];
  const sourceSummary = text(record.Summary) || null;
  const withoutHash: Omit<RealPublicIncident, "contentHash"> = {
    id: `RP-POSTMORTEMS_APP-${sourceRecordId}`,
    corpusType: "REAL_PUBLIC",
    sourceProvider: "POSTMORTEMS_APP",
    title,
    company,
    incidentDateStart: normalizedDate(record.StartTime),
    incidentDateEnd: normalizedDate(record.EndTime),
    publishedAt: normalizedDate(record.SourcePublishedAt),
    categories: strings(record.Categories),
    products,
    sourceUrl: canonicalizeUrl(`https://postmortems.app/postmortem/${sourceRecordId}`),
    originalSourceUrl,
    datasetLicense: DATASET_LICENSE,
    originalContentRights: {
      status: "SOURCE_SPECIFIC",
      licenseName: null,
      licenseUrl: null,
      sourceUrl: originalSourceUrl,
    },
    sourceRecordId,
    sourcePayloadHash: snapshot.sourcePayloadHash,
    snapshotVersion: snapshot.snapshotVersion,
    retrievedAt: new Date(snapshot.retrievedAt).toISOString(),
    causeSummary: null,
    impactSummary: null,
    detectionSummary: null,
    mitigationSummary: null,
    resolutionSummary: null,
    lessonsSummary: null,
    sourceSummary,
    rawMetadata: {
      archiveUrl: text(record.ArchiveURL) || null,
      keywords: strings(record.Keywords),
      sourceFetchedAt: normalizedDate(record.SourceFetchedAt),
      providerEndpoint: snapshot.providerEndpoint,
      etag: snapshot.etag,
      lastModified: snapshot.lastModified,
    },
    ingestionVersion: PUBLIC_INCIDENT_INGESTION_VERSION,
  };
  return {
    ...withoutHash,
    contentHash: await sha256(stableContent(withoutHash)),
  };
}
