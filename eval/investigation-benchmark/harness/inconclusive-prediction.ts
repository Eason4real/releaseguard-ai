export const INCONCLUSIVE_PREDICTION_FALLBACK =
  "Insufficient evidence to determine a root cause from the available observations.";

const MAX_ALTERNATIVES = 3;
const MAX_STATEMENT_LENGTH = 320;
const MAX_PREDICTION_LENGTH = 1_200;

const STATUS_RANK: Record<string, number> = {
  CONFIRMED: 0,
  SUPPORTED: 1,
  ACTIVE: 2,
  WEAKENED: 3,
};

const CONFIDENCE_RANK: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

const TRAILING_PUNCTUATION = /[\s.!?,;:。！？，；：]+$/u;
const UNSAFE_CODE_POINT = /[\p{Cc}\p{Cs}]/u;
const BOUNDARY = /[\s\p{P}]/u;

export type InconclusivePredictionInput = {
  run: {
    status: string;
    stopReason: string | null;
  };
  hypotheses: Array<{
    statement: string;
    status: string;
    confidence: string;
    supportScore: number;
    contradictionScore: number;
    createdAt?: string | null;
  }>;
};

type Candidate = InconclusivePredictionInput["hypotheses"][number] & {
  visibleStatement: string;
  canonicalStatement: string;
  statusRank: number;
  confidenceRank: number;
  netScore: number;
  comparableCreatedAt: string | null;
};

type CreatedAtState =
  | { kind: "MISSING" }
  | { kind: "VALID"; value: string }
  | { kind: "INVALID" };

const truncateStatement = (value: string) => {
  const characters = Array.from(value);
  if (characters.length <= MAX_STATEMENT_LENGTH) return value;

  const contentLimit = MAX_STATEMENT_LENGTH - 3;
  let boundaryIndex = -1;
  for (let index = 0; index < contentLimit; index += 1) {
    if (BOUNDARY.test(characters[index])) boundaryIndex = index;
  }
  if (boundaryIndex <= 0) return null;

  const truncated = characters.slice(0, boundaryIndex).join("")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
  return truncated ? truncated + "..." : null;
};

const normalizeStatement = (value: string) => {
  try {
    const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!normalized || UNSAFE_CODE_POINT.test(normalized)) return null;
    const withoutTrailingPunctuation = normalized.replace(TRAILING_PUNCTUATION, "").trim();
    if (!withoutTrailingPunctuation) return null;
    const visibleStatement = truncateStatement(withoutTrailingPunctuation);
    return visibleStatement ? {
      visibleStatement,
      canonicalStatement: withoutTrailingPunctuation.toLowerCase(),
    } : null;
  } catch {
    return null;
  }
};

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const classifyCreatedAt = (value: unknown): CreatedAtState => {
  if (value === undefined || value === null) return { kind: "MISSING" };
  if (typeof value !== "string" || value.length === 0) return { kind: "INVALID" };
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
    ? { kind: "VALID", value }
    : { kind: "INVALID" };
};

const compareCreatedAt = (left: string | null, right: string | null) => {
  if (left !== null && right !== null) return compareText(left, right);
  if (left !== null) return -1;
  if (right !== null) return 1;
  return 0;
};

const candidatesFrom = (hypotheses: InconclusivePredictionInput["hypotheses"]) => {
  const candidates = hypotheses.flatMap((hypothesis): Candidate[] => {
    const statusRank = STATUS_RANK[hypothesis.status];
    const confidenceRank = CONFIDENCE_RANK[hypothesis.confidence];
    const normalizedStatement = normalizeStatement(hypothesis.statement);
    const createdAt = classifyCreatedAt(hypothesis.createdAt);
    if (
      statusRank === undefined
      || confidenceRank === undefined
      || normalizedStatement === null
      || !Number.isFinite(hypothesis.supportScore)
      || !Number.isFinite(hypothesis.contradictionScore)
      || createdAt.kind === "INVALID"
    ) return [];
    return [{
      ...hypothesis,
      ...normalizedStatement,
      statusRank,
      confidenceRank,
      netScore: hypothesis.supportScore - hypothesis.contradictionScore,
      comparableCreatedAt: createdAt.kind === "VALID" ? createdAt.value : null,
    }];
  }).sort((left, right) =>
    left.statusRank - right.statusRank
    || left.confidenceRank - right.confidenceRank
    || right.netScore - left.netScore
    || compareCreatedAt(left.comparableCreatedAt, right.comparableCreatedAt)
    || compareText(left.canonicalStatement, right.canonicalStatement));

  const canonicalStatements = new Set<string>();
  return candidates.filter((candidate) => {
    if (canonicalStatements.has(candidate.canonicalStatement)) return false;
    canonicalStatements.add(candidate.canonicalStatement);
    return true;
  }).slice(0, MAX_ALTERNATIVES);
};

export function projectInconclusivePrediction(
  input: InconclusivePredictionInput,
): string | null {
  if (input.run.status !== "INCONCLUSIVE") return null;

  const alternatives = candidatesFrom(input.hypotheses)
    .map((candidate) => candidate.visibleStatement);
  if (alternatives.length === 0) return INCONCLUSIVE_PREDICTION_FALLBACK;

  const prediction = alternatives.length === 1
    ? "Insufficient evidence to confirm this explanation as the root cause, so no finalized " +
      "diagnosis was produced. This explanation remains plausible but not sufficiently confirmed: " +
      alternatives[0] + "."
    : "Insufficient evidence to confirm a single root cause. The following unresolved " +
      "alternatives remain plausible, and the available observations cannot distinguish among " +
      "them: " + alternatives.map((alternative, index) =>
        "(" + String(index + 1) + ") " + alternative).join("; ") + ".";

  return Array.from(prediction).length <= MAX_PREDICTION_LENGTH
    ? prediction
    : INCONCLUSIVE_PREDICTION_FALLBACK;
}
