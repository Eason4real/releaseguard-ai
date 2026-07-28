import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalJson,
  hashSourcePayload,
  normalizePostmortemsAppRecord,
  sha256,
} from "../lib/retrieval/public-incidents/normalize";
import {
  PUBLIC_INCIDENT_INGESTION_VERSION,
  PUBLIC_INCIDENT_SNAPSHOT_VERSION,
  REAL_PUBLIC_CORPUS_VERSION,
  type PostmortemsAppRecord,
  type PublicIncidentMechanism,
  type PublicIncidentSourceSnapshot,
} from "../lib/retrieval/public-incidents/types";

const CREATED_AT = "2026-07-28T12:00:00.000Z";
const providerBase = "https://postmortems.app/postmortem";

const accepted = [
  ["402733d3-31ee-4ca3-b769-0a9cdf7dd59f", ["OBSERVABILITY_FAILURE", "CONFIGURATION_PROPAGATION", "CASCADING_FAILURE"]],
  ["24be1eec-6da2-4825-853c-4b2561bdd422", ["CONFIGURATION_PROPAGATION", "CASCADING_FAILURE"]],
  ["a50e7b06-2f2c-4d13-a340-9a1e7eed59d7", ["CACHE_FAILURE", "DATABASE_OVERLOAD", "CASCADING_FAILURE"]],
  ["f70ce67c-0944-422e-b0bd-be38f0edb0cd", ["DATABASE_OVERLOAD", "DATA_CORRUPTION_OR_LOSS"]],
  ["b3ecf309-d821-44e9-9755-b49540b6a90c", ["DATABASE_OVERLOAD", "CACHE_FAILURE"]],
  ["029b4a8e-0332-4b91-abc3-5f84bdf70094", ["QUEUE_OR_WORKER_FAILURE", "OBSERVABILITY_FAILURE"]],
  ["20834b0c-3811-4447-bcfe-2e60eeeb6251", ["DEPLOYMENT_OR_RELEASE_REGRESSION", "CONFIGURATION_PROPAGATION"]],
  ["fccb0ca5-3db5-4481-98ba-af8f26528a93", ["DEPLOYMENT_OR_RELEASE_REGRESSION", "DATA_CORRUPTION_OR_LOSS"]],
  ["d5b64671-0716-4332-ba81-cec110c5baec", ["DEPLOYMENT_OR_RELEASE_REGRESSION", "QUEUE_OR_WORKER_FAILURE"]],
  ["22e646c4-198c-4985-bb8e-e64e8a13d68e", ["DEPENDENCY_OR_THIRD_PARTY_OUTAGE", "QUEUE_OR_WORKER_FAILURE"]],
  ["14024599-5ca4-479d-a537-d36c393f97a6", ["DATABASE_OVERLOAD", "QUEUE_OR_WORKER_FAILURE", "CAPACITY_EXHAUSTION"]],
  ["dc34b433-0ddd-45dd-85bf-cfa6d8cce764", ["DATABASE_OVERLOAD", "QUEUE_OR_WORKER_FAILURE", "CAPACITY_EXHAUSTION"]],
  ["f9f4ba4c-686c-46a4-982c-8dc21bd8a448", ["DATABASE_OVERLOAD", "DEPLOYMENT_OR_RELEASE_REGRESSION"]],
  ["34b4a47b-a3d6-4bda-acc9-57b621f53468", ["DATABASE_OVERLOAD", "CAPACITY_EXHAUSTION"]],
  ["eb95646f-90c2-4efe-b89e-060debafa0fc", ["NETWORK_OR_DNS", "CAPACITY_EXHAUSTION"]],
  ["e9248be4-2e55-481e-bde1-f53f60667e21", ["NETWORK_OR_DNS", "CONFIGURATION_PROPAGATION", "CAPACITY_EXHAUSTION"]],
  ["36858814-a276-4723-8bd2-ce1d46236417", ["NETWORK_OR_DNS", "CASCADING_FAILURE"]],
  ["d9ae38c1-c5da-4138-9919-5fc5e21a70a9", ["NETWORK_OR_DNS", "CONFIGURATION_PROPAGATION"]],
  ["e16b28f3-b6d4-449b-ae93-cc8a4d074163", ["NETWORK_OR_DNS", "CAPACITY_EXHAUSTION"]],
  ["32b081c5-bfd7-4986-82e6-9e9cd7740c95", ["CACHE_FAILURE", "DEPLOYMENT_OR_RELEASE_REGRESSION"]],
  ["f98d88c2-febd-4e0d-a4c0-06547bfc3e65", ["CACHE_FAILURE", "DATABASE_OVERLOAD"]],
  ["e696c413-9af6-4e51-b073-51edbdb1ed2a", ["CACHE_FAILURE", "DATABASE_OVERLOAD", "CASCADING_FAILURE"]],
  ["e7d7aa93-81f7-4338-9c0b-6e6c0dcefdcb", ["CAPACITY_EXHAUSTION", "OBSERVABILITY_FAILURE"]],
  ["30bde82e-27e3-48da-873b-499ddc119a8f", ["QUEUE_OR_WORKER_FAILURE", "CASCADING_FAILURE", "OBSERVABILITY_FAILURE"]],
  ["cc1e5d23-573c-450c-9e61-ce71ffc91318", ["DEPLOYMENT_OR_RELEASE_REGRESSION", "NETWORK_OR_DNS"]],
  ["0787bc22-cd28-42d0-a0b2-71610a38a78f", ["NETWORK_OR_DNS", "CASCADING_FAILURE"]],
  ["e44dd5d3-5105-45ed-9582-f9041a7cfdb9", ["DEPENDENCY_OR_THIRD_PARTY_OUTAGE", "CASCADING_FAILURE"]],
  ["300cba9e-d50d-45c4-86fd-0142c6cb9101", ["DEPENDENCY_OR_THIRD_PARTY_OUTAGE"]],
  ["090ac94f-65d7-49cc-9e5d-1c8c000b2042", ["DEPENDENCY_OR_THIRD_PARTY_OUTAGE", "CAPACITY_EXHAUSTION"]],
  ["0d5441d3-c69a-4a0a-ab5f-c5ef6e7cc774", ["DATA_CORRUPTION_OR_LOSS", "DEPENDENCY_OR_THIRD_PARTY_OUTAGE"]],
  ["2349ef07-ccb1-421c-94f8-68952f1a4058", ["DATA_CORRUPTION_OR_LOSS", "AUTHENTICATION_OR_PERMISSION"]],
  ["0dfe934b-9234-4383-9d1c-de9b860a43d1", ["DATA_CORRUPTION_OR_LOSS"]],
  ["27672984-d1e8-4a31-b08c-75c8c54e6314", ["AUTHENTICATION_OR_PERMISSION", "CONFIGURATION_PROPAGATION"]],
  ["d6db1e76-af37-435c-83e9-e7c7cabfaf0f", ["AUTHENTICATION_OR_PERMISSION", "CASCADING_FAILURE"]],
  ["217ee689-0975-41e9-9080-0d89838812d7", ["CAPACITY_EXHAUSTION", "CASCADING_FAILURE"]],
  ["d17fe136-eb00-44f8-8147-e3dc22358cba", ["DEPENDENCY_OR_THIRD_PARTY_OUTAGE", "CASCADING_FAILURE"]],
  ["3435a88e-1b33-447e-9b4e-fda0625db87f", ["OBSERVABILITY_FAILURE", "CASCADING_FAILURE"]],
  ["e242d62d-32f3-4bc0-b4e9-5a0a15a82863", ["CAPACITY_EXHAUSTION", "AUTHENTICATION_OR_PERMISSION"]],
  ["d44e5d9b-5c18-4cbe-b624-46bb9a311b84", ["DATA_CORRUPTION_OR_LOSS", "DATABASE_OVERLOAD"]],
  ["c990285e-31b4-48e1-b535-bf18869268ad", ["DATABASE_OVERLOAD", "CAPACITY_EXHAUSTION", "CASCADING_FAILURE"]],
  ["e81a4a73-8808-42da-9841-9bd4fcc8b9be", ["DEPLOYMENT_OR_RELEASE_REGRESSION", "AUTHENTICATION_OR_PERMISSION"]],
  ["27ad61bb-5843-4164-bb8f-3c8def55d77c", ["QUEUE_OR_WORKER_FAILURE", "CASCADING_FAILURE", "CONFIGURATION_PROPAGATION"]],
] as const satisfies ReadonlyArray<readonly [string, readonly PublicIncidentMechanism[]]>;

const rejected = [
  ["04f5afd8-09fc-4314-9c60-7f942faca125", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["06ceee47-94f1-400b-bf58-7482d740d5e6", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["0afb9162-9810-4b29-b5f3-d2f41508aede", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["23713fc8-675d-4de9-9127-7950f10c6131", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["24049f4d-af54-4622-b0fd-a291117c7bc9", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["2552ccf5-4e03-40b1-a1fa-354a34bfa5fe", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["e78185fe-c16e-4f5f-9c44-785b99850ff5", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
  ["e83c06be-7df9-484d-8de6-342ae21d87c4", "MISSING_TITLE_AND_TECHNICAL_SUMMARY"],
] as const;

const minimalPayload = (input: PostmortemsAppRecord): PostmortemsAppRecord => ({
  UUID: input.UUID,
  URL: input.URL,
  ArchiveURL: input.ArchiveURL,
  Title: input.Title,
  StartTime: input.StartTime,
  EndTime: input.EndTime,
  Categories: input.Categories,
  Keywords: input.Keywords,
  Company: input.Company,
  Product: input.Product,
  SourcePublishedAt: input.SourcePublishedAt,
  SourceFetchedAt: input.SourceFetchedAt,
  Summary: input.Summary,
});

async function main() {
  if (!process.argv.includes("--confirm-live-refresh")) {
    throw new Error("LIVE_REFRESH_REQUIRES_--confirm-live-refresh");
  }
  const snapshots: PublicIncidentSourceSnapshot[] = [];
  for (const [sourceRecordId] of accepted) {
    const providerEndpoint = `${providerBase}/${sourceRecordId}.json`;
    const response = await fetch(providerEndpoint, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`SOURCE_FETCH_FAILED:${sourceRecordId}:${response.status}`);
    const payload = minimalPayload(await response.json() as PostmortemsAppRecord);
    snapshots.push({
      sourceProvider: "POSTMORTEMS_APP",
      sourceRecordId,
      providerEndpoint,
      retrievedAt: CREATED_AT,
      sourcePayloadHash: await hashSourcePayload(payload),
      snapshotVersion: PUBLIC_INCIDENT_SNAPSHOT_VERSION,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      payload,
    });
  }
  const mechanismsById = new Map<string, PublicIncidentMechanism[]>(
    accepted.map(([id, mechanisms]) => [id, [...mechanisms]]),
  );
  const records = await Promise.all(snapshots.map(async (snapshot) => {
    const normalized = await normalizePostmortemsAppRecord(
      snapshot,
      mechanismsById.get(snapshot.sourceRecordId) ?? [],
    );
    return {
      sourceProvider: normalized.sourceProvider,
      sourceId: normalized.sourceRecordId,
      sourceRecordId: normalized.sourceRecordId,
      revision: 1,
      title: normalized.title,
      company: normalized.company,
      incidentDate: normalized.incidentDateStart,
      categories: normalized.categories,
      mechanisms: mechanismsById.get(normalized.sourceRecordId) ?? [],
      sourceUrl: normalized.sourceUrl,
      originalSourceUrl: normalized.originalSourceUrl,
      datasetLicense: normalized.datasetLicense,
      originalContentRights: normalized.originalContentRights,
      sourcePayloadHash: normalized.sourcePayloadHash,
      contentHash: normalized.contentHash,
      snapshotVersion: normalized.snapshotVersion,
      ingestionStatus: "ACCEPTED" as const,
    };
  }));
  const manifestBase = {
    schemaVersion: "2",
    corpusVersion: REAL_PUBLIC_CORPUS_VERSION,
    createdAt: CREATED_AT,
    incidentCount: records.length,
    companies: [...new Set(records.map((record) => record.company))].sort(),
    mechanisms: [...new Set(records.flatMap((record) => record.mechanisms))].sort(),
    categories: [...new Set(records.flatMap((record) => record.categories))].sort(),
    ingestionVersion: PUBLIC_INCIDENT_INGESTION_VERSION,
    snapshotVersion: PUBLIC_INCIDENT_SNAPSHOT_VERSION,
    sourceProvider: "POSTMORTEMS_APP" as const,
    datasetLicense: records[0].datasetLicense,
    records,
    rejectedCandidates: rejected.map(([sourceId, reason]) => ({
      sourceProvider: "POSTMORTEMS_APP", sourceId, sourceRecordId: sourceId, reason,
    })),
  };
  const manifest = { ...manifestBase, manifestHash: await sha256(canonicalJson(manifestBase)) };
  const root = process.cwd();
  await writeFile(resolve(root, "data/public-incidents/curated-source-v1.json"), `${JSON.stringify({
    snapshotVersion: PUBLIC_INCIDENT_SNAPSHOT_VERSION,
    sourceProvider: "POSTMORTEMS_APP",
    records: snapshots,
  }, null, 2)}\n`);
  await writeFile(resolve(root, "data/public-incidents/corpus-v1-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const oldManifest = JSON.parse(await readFile(resolve(root, "data/public-incidents/manifest.json"), "utf8")) as { records: unknown[] };
  console.log(JSON.stringify({ incidentCount: records.length, companies: manifestBase.companies.length,
    mechanisms: manifestBase.mechanisms.length, priorSmokeRecords: oldManifest.records.length,
    manifestHash: manifest.manifestHash }, null, 2));
}

await main();
