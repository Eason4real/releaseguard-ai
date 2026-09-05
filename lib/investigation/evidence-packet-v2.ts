import { getPendingEvidence } from "./hypothesis-invariants";
import type {
  EvidenceRelation,
  InvestigationAggregate,
  ToolCallWithResult,
} from "./types";

export type EvidenceTimeWindow = {
  start: string | null;
  end: string | null;
};

export type EvidenceFact =
  | {
      kind: "RELEASE";
      version: string;
      platform: string;
      modules: string[];
      flags: string[];
      rolloutPercent: number | null;
      releasedAt: string | null;
    }
  | {
      kind: "METRIC";
      metricKey: string;
      value: number | null;
      baseline: number | null;
      delta: number | null;
      sampleSize: number | null;
      window: EvidenceTimeWindow;
      measurements?: Array<{
        name: string;
        value: string | number | boolean;
      }>;
    }
  | {
      kind: "SEGMENT";
      metricKey: string;
      dimension: string;
      groups: Array<{
        name: string;
        value: number | null;
        baseline: number | null;
        sampleSize: number | null;
      }>;
    }
  | {
      kind: "FEEDBACK";
      themes: Array<{ label: string; count: number | null }>;
      representativeSamples: string[];
      filters: Record<string, string>;
      coverage: string | null;
    }
  | {
      kind: "HISTORICAL";
      incidentIds: string[];
      similarities: string[];
      differences: string[];
      coverage: string | null;
    };

export type EvidenceReadinessV2Status =
  | "READY_FOR_CAUSAL"
  | "READY_FOR_BOUNDED_HYPOTHESIS"
  | "READY_FOR_ABSTENTION"
  | "NEEDS_COLLECTION";

export type EvidenceReadinessV2Decision = {
  status: EvidenceReadinessV2Status;
  reasons: string[];
  missingCategories: string[];
  categoriesPresent: string[];
  independentCurrentSources: number;
  supportedHypothesisIds: string[];
  leadingHypothesisId: string | null;
  unresolvedCompetingHypothesisIds: string[];
};

export type EvidencePacketV2 = {
  schemaVersion: "releaseguard-evidence-packet-v2";
  investigation: {
    runId: string;
    question: string;
    incidentId: string;
    release: { id: string; version: string; platform: string } | null;
    riskEvent: {
      metricKey: string;
      firstBreachedAt: string;
      lastBreachedAt: string;
    } | null;
  };
  hypotheses: Array<{
    id: string;
    statement: string;
    status: string;
    confidence: string;
    supportScore: number;
    contradictionScore: number;
    supportIf: string;
    refuteIf: string;
  }>;
  evidence: Array<{
    id: string;
    category: string;
    source: string;
    strength: string;
    provenance: string;
    collectedAt: string;
    toolResultId: string;
    factSummary: string;
    facts: EvidenceFact[];
    scope: {
      start: string | null;
      end: string | null;
      platform: string | null;
      version: string | null;
      region: string | null;
      userType: string | null;
    };
    relations: Array<{
      hypothesisId: string;
      relation: EvidenceRelation;
      explanation: string;
    }>;
    limitations: string[];
  }>;
  readiness: EvidenceReadinessV2Decision;
};

const CURRENT_INCIDENT_CATEGORIES = new Set([
  "RELEASE_CHANGE",
  "PRODUCT_METRIC",
  "SEGMENT_METRIC",
  "USER_FEEDBACK",
]);
const MAX_TEXT_LENGTH = 240;
const MAX_LIST_ITEMS = 20;
const MAX_SAMPLES = 3;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown) => typeof value === "string" && value.trim()
  ? value.trim().slice(0, MAX_TEXT_LENGTH)
  : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? value
  : null;
const strings = (value: unknown, limit = MAX_LIST_ITEMS) => Array.isArray(value)
  ? value.flatMap((item) => {
      const normalized = text(item);
      return normalized ? [normalized] : [];
    }).slice(0, limit)
  : [];
const firstText = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
};
const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = number(value);
    if (normalized !== null) return normalized;
  }
  return null;
};
const stableUnique = (values: string[]) => [...new Set(values)].sort();
const FORBIDDEN_FACT_KEY = /(?:secret|token|password|credential|authorization|transcript|chain.?of.?thought|gold|expected|score|case.?id|evidence.?id)/i;

const safeMeasurements = (value: unknown) => {
  const entries: Array<{ name: string; value: string | number | boolean }> = [];
  const visit = (item: unknown, path: string, depth: number) => {
    if (entries.length >= MAX_LIST_ITEMS || depth > 3) return;
    if (typeof item === "number" && Number.isFinite(item)) {
      entries.push({ name: path, value: item });
      return;
    }
    if (typeof item === "boolean") {
      entries.push({ name: path, value: item });
      return;
    }
    if (typeof item === "string" && item.trim() && item.length <= 80) {
      entries.push({ name: path, value: item.trim() });
      return;
    }
    if (Array.isArray(item)) {
      item.slice(0, 8).forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(record(item)).sort(([left], [right]) =>
      left.localeCompare(right))) {
      if (FORBIDDEN_FACT_KEY.test(key)) continue;
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(value, "", 0);
  return entries.filter((item) => item.name)
    .sort((left, right) => left.name.localeCompare(right.name));
};

const scopeFilters = (value: unknown) => {
  const input = record(value);
  return Object.fromEntries([
    ["platform", firstText(input.platform)],
    ["version", firstText(input.version, input.appVersion, input.app_version)],
    ["region", firstText(input.region)],
    ["userType", firstText(input.userType, input.user_type)],
  ].filter((entry): entry is [string, string] => entry[1] !== null));
};

const projectionContext = (
  aggregate: InvestigationAggregate,
  call: ToolCallWithResult | undefined,
) => {
  const output = record(call?.result?.output);
  const query = record(output.query);
  const data = record(output.data);
  return { output, query, data, args: record(call?.arguments) };
};

const projectReleaseFact = (
  aggregate: InvestigationAggregate,
  call: ToolCallWithResult | undefined,
): EvidenceFact | null => {
  const { data } = projectionContext(aggregate, call);
  const rollout = record(data.rollout);
  const version = firstText(data.version, aggregate.release?.version);
  const platform = firstText(data.platform, aggregate.release?.platform);
  if (!version && !platform && Object.keys(data).length === 0) return null;
  return {
    kind: "RELEASE",
    version: version ?? "UNKNOWN",
    platform: platform ?? "UNKNOWN",
    modules: stableUnique(strings(data.changed_modules ?? data.changedModules)),
    flags: stableUnique(strings(data.feature_flags ?? data.featureFlags)),
    rolloutPercent: firstNumber(
      rollout.percentage,
      data.rollout_percentage,
      aggregate.release?.rolloutPercentage,
    ),
    releasedAt: firstText(data.released_at, data.releasedAt, aggregate.release?.releasedAt),
  };
};

const projectMetricFact = (
  aggregate: InvestigationAggregate,
  call: ToolCallWithResult | undefined,
): EvidenceFact | null => {
  const { data, query, args } = projectionContext(aggregate, call);
  const summary = record(data.summary);
  const metricKey = firstText(
    data.metric,
    query.metric_key,
    query.metricKey,
    args.metric_key,
    args.metricKey,
    aggregate.riskEvent?.metricKey,
  );
  if (!metricKey) return null;
  const value = firstNumber(summary.value, data.value);
  const baseline = firstNumber(summary.baseline, record(data.baseline).value);
  const measurements = Object.keys(summary).length === 0 ? safeMeasurements(data) : [];
  return {
    kind: "METRIC",
    metricKey,
    value,
    baseline,
    delta: firstNumber(
      summary.absolute_change,
      summary.delta,
      value !== null && baseline !== null ? value - baseline : null,
    ),
    sampleSize: firstNumber(summary.sampleSize, summary.sample_size, data.sampleSize),
    window: {
      start: firstText(query.start_time, query.startTime, args.start_time, args.startTime),
      end: firstText(query.end_time, query.endTime, args.end_time, args.endTime),
    },
    ...(measurements.length > 0 ? { measurements } : {}),
  };
};

const projectSegmentFact = (
  aggregate: InvestigationAggregate,
  call: ToolCallWithResult | undefined,
): EvidenceFact | null => {
  const { data, query, args } = projectionContext(aggregate, call);
  const dimension = firstText(data.dimension, query.dimension, args.dimension);
  const metricKey = firstText(
    data.metric,
    query.metric_key,
    args.metric_key,
    aggregate.riskEvent?.metricKey,
  );
  if (!dimension || !metricKey) return null;
  const rawGroups = Array.isArray(data.breakdown)
    ? data.breakdown.map((item) => ({ prefix: "", item }))
    : ["before", "after"].flatMap((period) => Array.isArray(data[period])
      ? (data[period] as unknown[]).map((item) => ({ prefix: `${period}:`, item }))
      : []);
  const groups = rawGroups.flatMap(({ prefix, item }) => {
    const group = record(item);
    const name = firstText(group.segment_value, group.name, group.label,
      typeof group.value === "string" ? group.value : null);
    if (!name) return [];
    return [{
      name: `${prefix}${name}`,
      value: firstNumber(group.rate, group.metric_value, group.eventRate, group.event_rate,
        group.completionRate, group.completion_rate, group.percentage,
        typeof group.value === "number" ? group.value : null),
      baseline: firstNumber(group.baseline),
      sampleSize: firstNumber(group.sampleSize, group.sample_size),
    }];
  }).slice(0, MAX_LIST_ITEMS).sort((left, right) => left.name.localeCompare(right.name));
  return { kind: "SEGMENT", metricKey, dimension, groups };
};

const projectFeedbackFact = (call: ToolCallWithResult | undefined): EvidenceFact | null => {
  const { output, data, query, args } = projectionContext({} as InvestigationAggregate, call);
  const rawThemes = Array.isArray(data.themes) ? data.themes : [];
  const matches = Array.isArray(output.matches)
    ? output.matches
    : Array.isArray(data.matches) ? data.matches : [];
  const matchesWereReturned = Array.isArray(output.matches) || Array.isArray(data.matches);
  const coverage = firstText(output.coverage, data.coverage, output.queryWindow, data.queryWindow);
  const themes = rawThemes.flatMap((item) => {
    const theme = record(item);
    const label = firstText(theme.label, theme.name, theme.theme);
    return label ? [{ label, count: firstNumber(theme.count) }] : [];
  }).slice(0, MAX_LIST_ITEMS).sort((left, right) => left.label.localeCompare(right.label));
  const representativeSamples = matches.flatMap((item) => {
    const match = record(item);
    const sample = firstText(match.text, match.summary, match.content, match.title);
    return sample ? [sample] : [];
  }).slice(0, MAX_SAMPLES);
  if (themes.length === 0 && representativeSamples.length === 0
    && !matchesWereReturned && !coverage) return null;
  return {
    kind: "FEEDBACK",
    themes,
    representativeSamples,
    filters: scopeFilters(Object.keys(query).length > 0 ? query : args),
    coverage,
  };
};

const projectHistoricalFact = (call: ToolCallWithResult | undefined): EvidenceFact | null => {
  const { output, data } = projectionContext({} as InvestigationAggregate, call);
  const matches = Array.isArray(output.matches)
    ? output.matches
    : Array.isArray(data.matches) ? data.matches : [];
  const matchesWereReturned = Array.isArray(output.matches) || Array.isArray(data.matches);
  const coverage = firstText(output.coverage, data.coverage, output.queryWindow, data.queryWindow);
  const incidentIds: string[] = [];
  const similarities: string[] = [];
  const differences: string[] = [];
  for (const item of matches.slice(0, MAX_LIST_ITEMS)) {
    const match = record(item);
    const id = firstText(match.incidentId, match.incident_id, match.id);
    if (id) incidentIds.push(id);
    const similarity = firstText(
      match.similarity_summary,
      match.similarities,
      match.title,
      match.chunk,
    );
    if (similarity) similarities.push(similarity);
    const score = firstNumber(match.similarity, match.score, match.relevance);
    if (score !== null) similarities.push(`similarity=${score}`);
    differences.push(...strings(match.differences, 5));
  }
  if (incidentIds.length === 0 && similarities.length === 0 && differences.length === 0
    && !matchesWereReturned && !coverage) return null;
  return {
    kind: "HISTORICAL",
    incidentIds: stableUnique(incidentIds),
    similarities: stableUnique(similarities).slice(0, MAX_LIST_ITEMS),
    differences: stableUnique(differences).slice(0, MAX_LIST_ITEMS),
    coverage,
  };
};

const projectFacts = (
  category: string,
  aggregate: InvestigationAggregate,
  call: ToolCallWithResult | undefined,
): EvidenceFact[] => {
  if (!call?.result || call.result.status !== "SUCCESS") return [];
  const fact = category === "RELEASE_CHANGE"
    ? projectReleaseFact(aggregate, call)
    : category === "PRODUCT_METRIC"
      ? projectMetricFact(aggregate, call)
      : category === "SEGMENT_METRIC"
        ? projectSegmentFact(aggregate, call)
        : category === "USER_FEEDBACK"
          ? projectFeedbackFact(call)
          : category === "SIMILAR_INCIDENT"
            ? projectHistoricalFact(call)
            : null;
  return fact ? [fact] : [];
};

const factSummary = (facts: EvidenceFact[], fallback: string) => {
  const fact = facts[0];
  if (!fact) return fallback.slice(0, MAX_TEXT_LENGTH);
  if (fact.kind === "RELEASE") {
    const modules = fact.modules.length > 0 ? `; modules=${fact.modules.join(",")}` : "";
    return `Release ${fact.platform} ${fact.version}${modules}; rollout=${fact.rolloutPercent ?? "unknown"}`
      .slice(0, MAX_TEXT_LENGTH);
  }
  if (fact.kind === "METRIC") {
    if (fact.measurements?.length) {
      return `Metric ${fact.metricKey}: ${fact.measurements.map((item) => `${item.name}=${item.value}`).join(",")}`
        .slice(0, MAX_TEXT_LENGTH);
    }
    return `Metric ${fact.metricKey}: value=${fact.value ?? "unknown"}, baseline=${fact.baseline ?? "unknown"}, delta=${fact.delta ?? "unknown"}, sample=${fact.sampleSize ?? "unknown"}`
      .slice(0, MAX_TEXT_LENGTH);
  }
  if (fact.kind === "SEGMENT") {
    const groups = fact.groups.map((item) => `${item.name}=${item.value ?? "unknown"}`).join(",");
    return `Segment ${fact.metricKey} by ${fact.dimension}: ${groups}`.slice(0, MAX_TEXT_LENGTH);
  }
  if (fact.kind === "FEEDBACK") {
    return `Feedback: themes=${fact.themes.map((item) => item.label).join(",") || "none"}; samples=${fact.representativeSamples.length}; coverage=${fact.coverage ?? "unknown"}`
      .slice(0, MAX_TEXT_LENGTH);
  }
  return `Historical clues: incidents=${fact.incidentIds.join(",") || "none"}; coverage=${fact.coverage ?? "unknown"}; not proof of current cause`
    .slice(0, MAX_TEXT_LENGTH);
};

const limitationsFor = (facts: EvidenceFact[]) => {
  const fact = facts[0];
  if (!fact) return ["STRUCTURED_FACTS_UNAVAILABLE"];
  const limitations: string[] = [];
  if (fact.kind === "METRIC") {
    if (fact.baseline === null) limitations.push("BASELINE_UNAVAILABLE");
    if (fact.sampleSize === null) limitations.push("SAMPLE_SIZE_UNAVAILABLE");
    if (fact.window.start === null || fact.window.end === null) limitations.push("TIME_WINDOW_INCOMPLETE");
  }
  if (fact.kind === "SEGMENT" && fact.groups.length === 0) limitations.push("SEGMENT_GROUPS_UNAVAILABLE");
  if (fact.kind === "FEEDBACK" && fact.representativeSamples.length === 0) {
    limitations.push("REPRESENTATIVE_SAMPLES_UNAVAILABLE");
  }
  if (fact.kind === "HISTORICAL") limitations.push("HISTORICAL_CLUE_NOT_CURRENT_CAUSAL_PROOF");
  return limitations.sort();
};

const evidenceScope = (
  aggregate: InvestigationAggregate,
  call: ToolCallWithResult | undefined,
) => {
  const { query, args } = projectionContext(aggregate, call);
  const queryFilters = record(query.filters);
  const argumentFilters = record(args.filters);
  const riskFilters = record(aggregate.riskEvent?.filters);
  return {
    start: firstText(query.start_time, query.startTime, args.start_time, args.startTime),
    end: firstText(query.end_time, query.endTime, args.end_time, args.endTime),
    platform: firstText(
      query.platform,
      queryFilters.platform,
      args.platform,
      argumentFilters.platform,
      riskFilters.platform,
      aggregate.release?.platform,
    ),
    version: firstText(
      query.version,
      query.appVersion,
      queryFilters.appVersion,
      args.version,
      argumentFilters.appVersion,
      riskFilters.appVersion,
      aggregate.release?.version,
    ),
    region: firstText(query.region, queryFilters.region, args.region, argumentFilters.region,
      riskFilters.region),
    userType: firstText(query.userType, queryFilters.userType, args.userType,
      argumentFilters.userType, riskFilters.userType),
  };
};

export function evaluateEvidenceReadinessV2(
  aggregate: InvestigationAggregate,
  remainingToolCalls: number,
): EvidenceReadinessV2Decision {
  const pending = new Set(getPendingEvidence(aggregate).map((item) => item.id));
  const assessed = aggregate.evidence.filter((item) => !pending.has(item.id));
  const categoriesPresent = stableUnique(assessed.map((item) => item.category));
  const categories = new Set(categoriesPresent);
  const current = assessed.filter((item) => CURRENT_INCIDENT_CATEGORIES.has(item.category));
  const independentCurrentSources = new Set(current.map((item) =>
    `${item.category}:${item.toolResultId}`)).size;
  const ranked = aggregate.hypotheses
    .filter((item) => !["REJECTED", "WEAKENED"].includes(item.status))
    .sort((left, right) => right.supportScore - left.supportScore
      || left.contradictionScore - right.contradictionScore
      || left.id.localeCompare(right.id));
  const supported = ranked.filter((item) => ["SUPPORTED", "CONFIRMED"].includes(item.status)
    && ["MEDIUM", "HIGH"].includes(item.confidence));
  const leading = supported[0] ?? null;
  const unresolvedCompetitors = leading
    ? supported.filter((item) => item.id !== leading.id
      && item.supportScore >= leading.supportScore
      && item.contradictionScore <= leading.contradictionScore)
    : [];
  const linkedSupport = leading ? aggregate.hypothesisEvidenceLinks.some((link) =>
    link.hypothesisId === leading.id
    && link.relation === "SUPPORTS"
    && current.some((item) => item.id === link.evidenceId)) : false;
  const linkedImpactSupport = leading ? aggregate.hypothesisEvidenceLinks.some((link) =>
    link.hypothesisId === leading.id
    && link.relation === "SUPPORTS"
    && current.some((item) => item.id === link.evidenceId
      && ["PRODUCT_METRIC", "SEGMENT_METRIC"].includes(item.category))) : false;
  const unresolvedUntestedCompetitors = leading ? ranked.filter((item) =>
    item.id !== leading.id
    && !["REJECTED", "WEAKENED"].includes(item.status)
    && (item.supportScore > 0 || item.contradictionScore > 0
      || ["MEDIUM", "HIGH"].includes(item.confidence)
      || aggregate.hypothesisEvidenceLinks.some((link) =>
        link.hypothesisId === item.id
        && ["SUPPORTS", "CONTRADICTS"].includes(link.relation)
        && current.some((evidence) => evidence.id === link.evidenceId)))
    && !aggregate.hypothesisEvidenceLinks.some((link) =>
      link.hypothesisId === item.id
      && link.relation === "CONTRADICTS"
      && current.some((evidence) => evidence.id === link.evidenceId))) : [];
  const allUnresolvedCompetitors = [...new Map([
    ...unresolvedCompetitors,
    ...unresolvedUntestedCompetitors,
  ].map((item) => [item.id, item])).values()];
  const impactPresent = categories.has("PRODUCT_METRIC") || categories.has("SEGMENT_METRIC");
  const missingCategories: string[] = [];
  if (!categories.has("RELEASE_CHANGE")) missingCategories.push("RELEASE_CONTEXT");
  if (!impactPresent) missingCategories.push("CURRENT_IMPACT");
  const reasons: string[] = [];
  if (aggregate.hypotheses.length < 2) reasons.push("COMPETING_HYPOTHESES_INCOMPLETE");
  if (pending.size > 0) reasons.push("PENDING_EVIDENCE_ASSESSMENT");
  if (!leading) reasons.push("NO_SUPPORTED_LEADING_HYPOTHESIS");
  if (!linkedSupport) reasons.push("NO_CURRENT_SUPPORT_FOR_LEADER");
  if (!linkedImpactSupport) reasons.push("NO_IMPACT_SUPPORT_FOR_LEADER");
  if (!impactPresent) reasons.push("CURRENT_IMPACT_UNAVAILABLE");
  if (unresolvedCompetitors.length > 0) reasons.push("UNRESOLVED_EQUAL_COMPETITOR");
  if (unresolvedUntestedCompetitors.length > 0) reasons.push("UNTESTED_VIABLE_COMPETITOR");

  let status: EvidenceReadinessV2Status;
  if (pending.size > 0 || (!leading && remainingToolCalls > 0)
    || (!impactPresent && remainingToolCalls > 0)
    || (!linkedImpactSupport && remainingToolCalls > 0)
    || (allUnresolvedCompetitors.length > 0 && remainingToolCalls > 0)) {
    status = "NEEDS_COLLECTION";
  } else if (leading && linkedSupport && linkedImpactSupport && impactPresent
    && independentCurrentSources >= 2 && allUnresolvedCompetitors.length === 0) {
    status = "READY_FOR_CAUSAL";
  } else if (leading || (impactPresent && current.length > 0)) {
    status = "READY_FOR_BOUNDED_HYPOTHESIS";
  } else {
    status = remainingToolCalls > 0 ? "NEEDS_COLLECTION" : "READY_FOR_ABSTENTION";
  }
  return {
    status,
    reasons: reasons.length > 0 ? reasons.sort() : ["CAUSAL_GROUNDING_REQUIREMENTS_MET"],
    missingCategories: missingCategories.sort(),
    categoriesPresent,
    independentCurrentSources,
    supportedHypothesisIds: supported.map((item) => item.id).sort(),
    leadingHypothesisId: leading?.id ?? null,
    unresolvedCompetingHypothesisIds: allUnresolvedCompetitors.map((item) => item.id).sort(),
  };
}

export function buildEvidencePacketV2(
  aggregate: InvestigationAggregate,
  readiness = evaluateEvidenceReadinessV2(aggregate, 0),
): EvidencePacketV2 {
  const callsByResultId = new Map(aggregate.toolCalls.flatMap((call) =>
    call.result ? [[call.result.id, call] as const] : []));
  const linksByEvidence = new Map<string, typeof aggregate.hypothesisEvidenceLinks>();
  for (const link of aggregate.hypothesisEvidenceLinks) {
    linksByEvidence.set(link.evidenceId, [...(linksByEvidence.get(link.evidenceId) ?? []), link]);
  }
  return {
    schemaVersion: "releaseguard-evidence-packet-v2",
    investigation: {
      runId: aggregate.run.id,
      question: aggregate.run.question.slice(0, 500),
      incidentId: aggregate.run.incidentId,
      release: aggregate.release ? {
        id: aggregate.release.id,
        version: aggregate.release.version,
        platform: aggregate.release.platform,
      } : null,
      riskEvent: aggregate.riskEvent ? {
        metricKey: aggregate.riskEvent.metricKey,
        firstBreachedAt: aggregate.riskEvent.firstBreachedAt,
        lastBreachedAt: aggregate.riskEvent.lastBreachedAt,
      } : null,
    },
    hypotheses: aggregate.hypotheses.map((item) => ({
      id: item.id,
      statement: item.statement.slice(0, 500),
      status: item.status,
      confidence: item.confidence,
      supportScore: item.supportScore,
      contradictionScore: item.contradictionScore,
      supportIf: item.supportIf.slice(0, 500),
      refuteIf: item.refuteIf.slice(0, 500),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    evidence: aggregate.evidence.map((item) => {
      const call = callsByResultId.get(item.toolResultId);
      const facts = projectFacts(item.category, aggregate, call);
      return {
        id: item.id,
        category: item.category,
        source: item.source.slice(0, MAX_TEXT_LENGTH),
        strength: item.strength,
        provenance: item.provenance,
        collectedAt: item.collectedAt,
        toolResultId: item.toolResultId,
        factSummary: factSummary(facts, item.statement),
        facts,
        scope: evidenceScope(aggregate, call),
        relations: (linksByEvidence.get(item.id) ?? []).map((link) => ({
          hypothesisId: link.hypothesisId,
          relation: link.relation,
          explanation: link.explanation.slice(0, MAX_TEXT_LENGTH),
        })).sort((left, right) => left.hypothesisId.localeCompare(right.hypothesisId)),
        limitations: limitationsFor(facts),
      };
    }).sort((left, right) => left.category.localeCompare(right.category)
      || left.id.localeCompare(right.id)),
    readiness,
  };
}
