import { hashSourcePayload } from "./normalize";
import {
  PUBLIC_INCIDENT_SNAPSHOT_VERSION,
  type PostmortemsAppRecord,
  type PublicIncidentSource,
  type PublicIncidentSourceSnapshot,
} from "./types";

const POSTMORTEMS_APP_ORIGIN = "https://postmortems.app";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const validatedProviderUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "https:"
    || url.hostname !== "postmortems.app"
    || (url.port && url.port !== "443")
    || url.username
    || url.password) {
    throw new Error("POSTMORTEMS_APP_REDIRECT_REJECTED");
  }
  return url;
};

export class PostmortemsAppSource implements PublicIncidentSource {
  readonly provider = "POSTMORTEMS_APP" as const;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly maxAttempts = 3,
    private readonly maxRedirects = 3,
    private readonly now: () => Date = () => new Date(),
  ) {}

  parse(input: unknown): PostmortemsAppRecord {
    if (!isRecord(input)) throw new Error("MALFORMED_SOURCE_RECORD");
    return input as PostmortemsAppRecord;
  }

  private async fetchOne(sourceRecordId: string) {
    let currentUrl = validatedProviderUrl(
      `${POSTMORTEMS_APP_ORIGIN}/postmortem/${encodeURIComponent(sourceRecordId)}.json`,
    );
    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const response = await this.fetcher(currentUrl, {
        redirect: "manual",
        headers: { accept: "application/json" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === this.maxRedirects) {
          throw new Error("POSTMORTEMS_APP_REDIRECT_REJECTED");
        }
        currentUrl = validatedProviderUrl(new URL(location, currentUrl).toString());
        continue;
      }
      return { response, providerEndpoint: currentUrl.toString() };
    }
    throw new Error("POSTMORTEMS_APP_REDIRECT_REJECTED");
  }

  async fetchRecords(sourceRecordIds: string[]): Promise<PublicIncidentSourceSnapshot[]> {
    const snapshots: PublicIncidentSourceSnapshot[] = [];
    for (const sourceRecordId of sourceRecordIds) {
      if (!UUID_PATTERN.test(sourceRecordId)) throw new Error("INVALID_SOURCE_RECORD_ID");
      let result: Awaited<ReturnType<PostmortemsAppSource["fetchOne"]>> | undefined;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        try {
          const candidate = await this.fetchOne(sourceRecordId);
          if (candidate.response.ok) {
            result = candidate;
            break;
          }
          const error = new Error(`POSTMORTEMS_APP_FETCH_FAILED:${sourceRecordId}:${candidate.response.status}`);
          if (candidate.response.status !== 429 && candidate.response.status < 500) throw error;
          lastError = error;
        } catch (error) {
          lastError = error;
          if (error instanceof Error
            && (error.message === "POSTMORTEMS_APP_REDIRECT_REJECTED"
              || error.message.startsWith("INVALID_SOURCE_RECORD_ID")
              || (error.message.startsWith("POSTMORTEMS_APP_FETCH_FAILED")
                && !error.message.endsWith(":429")
                && !/:5\d\d$/.test(error.message)))) throw error;
        }
      }
      if (!result) throw lastError ?? new Error(`POSTMORTEMS_APP_FETCH_FAILED:${sourceRecordId}`);
      const payload = this.parse(await result.response.json());
      snapshots.push({
        sourceProvider: this.provider,
        sourceRecordId,
        providerEndpoint: result.providerEndpoint,
        retrievedAt: this.now().toISOString(),
        sourcePayloadHash: await hashSourcePayload(payload),
        snapshotVersion: PUBLIC_INCIDENT_SNAPSHOT_VERSION,
        etag: result.response.headers.get("etag"),
        lastModified: result.response.headers.get("last-modified"),
        payload,
      });
    }
    return snapshots;
  }
}
