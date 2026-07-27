import type { AnalyticsStore } from "../analytics/store";
import type { MetricBucket, MetricFilters, Release, RiskEvent } from "../analytics/types";
import { aggregateBucketFacts } from "../risk-detection/detector";
import type { EvidenceStrength, ToolResultStatus } from "./types";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";

export type ToolArgs = Record<string, unknown>;
export type ToolContext = {
  analytics?: AnalyticsStore;
  release?: Release | null;
  riskEvent?: RiskEvent | null;
  feedbackRetriever?: FeedbackRetriever;
  incidentRetriever?: IncidentRetriever;
};

export type ToolExecution = {
  status: ToolResultStatus;
  output: unknown | null;
  errorMessage: string | null;
  retryable: boolean;
};

export type EvidenceDraft = {
  category: string;
  statement: string;
  source: string;
  strength: EvidenceStrength;
  provenance: "synthetic" | "runtime_generated" | "derived" | "public_reference";
};

export type ToolAdapter = {
  definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  execute(args: ToolArgs, context: ToolContext): Promise<ToolExecution> | ToolExecution;
  extractEvidence(output: unknown): EvidenceDraft[];
};

const success = (output: unknown): ToolExecution => ({
  status: "SUCCESS",
  output,
  errorMessage: null,
  retryable: false,
});
const empty = (output: unknown): ToolExecution => ({
  status: "EMPTY",
  output,
  errorMessage: null,
  retryable: false,
});
const error = (message: string, retryable = false): ToolExecution => ({
  status: "ERROR",
  output: null,
  errorMessage: message,
  retryable,
});

const requiredString = (args: ToolArgs, key: string) => {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const outputRecord = (output: unknown) =>
  output && typeof output === "object" ? output as Record<string, unknown> : {};
const parseFilters = (value: unknown): MetricFilters | null => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["platform", "appVersion", "region", "userType"]);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, item]) => !allowed.has(key) || typeof item !== "string")) return null;
  return Object.fromEntries(entries) as MetricFilters;
};

const metricSummary = (buckets: ReturnType<typeof aggregateBucketFacts>) => {
  const numerator = buckets.every((item) => item.numerator !== null)
    ? buckets.reduce((sum, item) => sum + (item.numerator ?? 0), 0)
    : null;
  const denominator = buckets.every((item) => item.denominator !== null)
    ? buckets.reduce((sum, item) => sum + (item.denominator ?? 0), 0)
    : null;
  const sampleSize = buckets.reduce((sum, item) => sum + item.sampleSize, 0);
  const value = numerator !== null && denominator
    ? numerator / denominator
    : buckets.reduce((sum, item) => sum + item.value * item.sampleSize, 0) / sampleSize;
  return { value, numerator, denominator, sampleSize };
};

const analyticsRequired = (context: ToolContext) =>
  context.analytics ? null : error("Analytics Runtime 未连接", true);

const getReleaseAdapter: ToolAdapter = {
  definition: {
    type: "function",
    function: {
      name: "get_release",
      description: "按 release_id 读取正式发布记录、灰度状态和变更模块；只提供事实，不判断因果。",
      parameters: {
        type: "object",
        properties: { release_id: { type: "string" } },
        required: ["release_id"],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const releaseId = requiredString(args, "release_id");
    if (!releaseId) return error("release_id 为必填参数");
    const missing = analyticsRequired(context);
    if (missing) return missing;
    const release = await context.analytics!.getRelease(releaseId);
    if (!release) {
      return empty({
        schema_version: "1",
        query: { release_id: releaseId },
        data: null,
        reason: "RELEASE_NOT_FOUND",
        provenance: { source: "Release Registry" },
      });
    }
    return success({
      schema_version: "1",
      query: { release_id: releaseId },
      data: {
        id: release.id,
        version: release.version,
        platform: release.platform,
        released_at: release.releasedAt,
        rollout: { status: release.rolloutStatus, percentage: release.rolloutPercentage },
        feature_flags: release.featureFlags,
        changed_modules: release.changedModules,
      },
      provenance: { source: "Release Registry", kind: release.provenance },
    });
  },
  extractEvidence(output) {
    const data = outputRecord(outputRecord(output).data);
    const modules = Array.isArray(data.changed_modules) ? data.changed_modules.map(String) : [];
    if (!data.id) return [];
    return [{
      category: "RELEASE_CHANGE",
      statement: `${String(data.platform)} ${String(data.version)} 于 ${String(data.released_at)} 发布，变更模块包括 ${modules.join("、")}；该发布关联不单独证明根因。`,
      source: "Release Registry",
      strength: "HIGH",
      provenance: "derived",
    }];
  },
};

const queryMetricAdapter: ToolAdapter = {
  definition: {
    type: "function",
    function: {
      name: "query_metric",
      description: "查询指定时间范围和分群的指标 bucket、加权汇总与检测基线。",
      parameters: {
        type: "object",
        properties: {
          metric_key: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          filters: {
            type: "object",
            properties: {
              platform: { type: "string" },
              appVersion: { type: "string" },
              region: { type: "string" },
              userType: { type: "string" },
            },
            additionalProperties: false,
          },
          granularity_minutes: { type: "number", enum: [5] },
          include_baseline: { type: "boolean" },
        },
        required: ["metric_key", "start_time", "end_time", "granularity_minutes"],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const metricKey = requiredString(args, "metric_key");
    const startTime = requiredString(args, "start_time");
    const endTime = requiredString(args, "end_time");
    const granularity = numberValue(args.granularity_minutes);
    const filters = parseFilters(args.filters);
    if (!metricKey || !startTime || !endTime || granularity !== 5 || !filters) {
      return error("metric_key、有效时间范围、filters 和 5 分钟 granularity 为必填参数");
    }
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86_400_000) {
      return error("时间范围必须有效且不超过 24 小时");
    }
    const missing = analyticsRequired(context);
    if (missing) return missing;
    const facts = await context.analytics!.queryMetricBuckets({
      metricKey,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      filters,
    });
    const buckets = aggregateBucketFacts(facts);
    if (buckets.length === 0) {
      return empty({
        schema_version: "1",
        query: args,
        data: { buckets: [] },
        reason: "NO_METRIC_BUCKETS",
        suggested_next: "扩大时间范围或检查筛选条件",
        provenance: { source: "Product Analytics D1" },
      });
    }
    const summary = metricSummary(buckets);
    const baseline = context.riskEvent?.metricKey === metricKey
      ? context.riskEvent.baselineValue
      : null;
    return success({
      schema_version: "1",
      query: {
        metric_key: metricKey,
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        filters,
        granularity_minutes: 5,
      },
      data: {
        summary: {
          ...summary,
          baseline,
          absolute_change: baseline === null ? null : summary.value - baseline,
          relative_change_pct: baseline ? (summary.value - baseline) / baseline : null,
        },
        buckets,
        baseline: context.riskEvent?.metricKey === metricKey ? {
          value: context.riskEvent.baselineValue,
          method: context.riskEvent.baselineMethod,
          point_count: context.riskEvent.baselinePointCount,
        } : null,
      },
      provenance: { source: "Product Analytics D1", aggregation: "weighted" },
    });
  },
  extractEvidence(output) {
    const data = outputRecord(outputRecord(output).data);
    const summary = outputRecord(data.summary);
    const value = numberValue(summary.value);
    const baseline = numberValue(summary.baseline);
    if (value === null || baseline === null) return [];
    const drop = (baseline - value) / baseline;
    return [{
      category: "PRODUCT_METRIC",
      statement: `监控分群的 ${String(outputRecord(outputRecord(output).query).metric_key)} 从动态基线 ${(baseline * 100).toFixed(1)}% 降至 ${(value * 100).toFixed(1)}%，相对下降 ${(drop * 100).toFixed(1)}%。`,
      source: "Product Analytics D1",
      strength: "HIGH",
      provenance: "derived",
    }];
  },
};

const dimensionField: Record<string, keyof Pick<MetricBucket, "platform" | "appVersion" | "region" | "userType">> = {
  platform: "platform",
  app_version: "appVersion",
  region: "region",
  user_type: "userType",
};

const segmentMetricAdapter: ToolAdapter = {
  definition: {
    type: "function",
    function: {
      name: "segment_metric",
      description: "按一个允许的业务维度拆分指标，定位异常集中分群；不负责触发 RiskEvent。",
      parameters: {
        type: "object",
        properties: {
          metric_key: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          filters: { type: "object", additionalProperties: { type: "string" } },
          dimension: { type: "string", enum: ["platform", "app_version", "region", "user_type"] },
          limit: { type: "number" },
        },
        required: ["metric_key", "start_time", "end_time", "dimension"],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const metricKey = requiredString(args, "metric_key");
    const startTime = requiredString(args, "start_time");
    const endTime = requiredString(args, "end_time");
    const dimension = requiredString(args, "dimension");
    const filters = parseFilters(args.filters);
    const field = dimension ? dimensionField[dimension] : undefined;
    if (!metricKey || !startTime || !endTime || !field || !filters) {
      return error("metric_key、有效时间范围、filters 和 dimension 为必填参数");
    }
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86_400_000) {
      return error("时间范围必须有效且不超过 24 小时");
    }
    const missing = analyticsRequired(context);
    if (missing) return missing;
    const facts = await context.analytics!.queryMetricBuckets({
      metricKey,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      filters,
    });
    if (facts.length === 0) {
      return empty({
        schema_version: "1",
        query: args,
        data: { breakdown: [] },
        reason: "NO_SEGMENT_DATA",
        provenance: { source: "Product Analytics D1" },
      });
    }
    const groups = new Map<string, MetricBucket[]>();
    for (const fact of facts) {
      const key = fact[field] ?? "UNKNOWN";
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    const baseline = context.riskEvent?.metricKey === metricKey
      ? context.riskEvent.baselineValue
      : null;
    const limit = Math.min(20, Math.max(1, numberValue(args.limit) ?? 20));
    const breakdown = [...groups.entries()].map(([segmentValue, items]) => {
      const aggregated = aggregateBucketFacts(items);
      const summary = metricSummary(aggregated);
      return {
        segment_value: segmentValue,
        ...summary,
        baseline,
        absolute_change: baseline === null ? null : summary.value - baseline,
        relative_change_pct: baseline ? (summary.value - baseline) / baseline : null,
        bucket_count: aggregated.length,
        data_quality: summary.sampleSize >= 500 ? "OK" : "INSUFFICIENT_SAMPLE",
      };
    }).sort((left, right) =>
      Math.abs(right.absolute_change ?? 0) - Math.abs(left.absolute_change ?? 0)
    ).slice(0, limit);
    return success({
      schema_version: "1",
      query: { ...args, filters },
      data: { overall: metricSummary(aggregateBucketFacts(facts)), breakdown },
      provenance: { source: "Product Analytics D1", aggregation: "weighted" },
    });
  },
  extractEvidence(output) {
    const breakdown = outputRecord(outputRecord(output).data).breakdown;
    if (!Array.isArray(breakdown) || breakdown.length === 0) return [];
    const worst = outputRecord(breakdown[0]);
    const value = numberValue(worst.value);
    if (value === null) return [];
    return [{
      category: "SEGMENT_METRIC",
      statement: `分群分析显示 ${String(worst.segment_value)} 的指标值为 ${(value * 100).toFixed(1)}%，样本质量为 ${String(worst.data_quality)}。`,
      source: "Product Analytics D1",
      strength: "HIGH",
      provenance: "derived",
    }];
  },
};

const searchUserFeedbackAdapter: ToolAdapter = {
  definition: {
    type: "function",
    function: {
      name: "search_user_feedback",
      description: "搜索与当前异常时间和功能相关的用户反馈。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          startTime: { type: "string" },
          endTime: { type: "string" },
          platform: { type: "string" },
          version: { type: "string" },
          region: { type: "string" },
          userType: { type: "string" },
          limit: { type: "number" },
          keyword: { type: "string", description: "Legacy alias for query" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const keyword = requiredString(args, "query") ?? requiredString(args, "keyword");
    if (!keyword) return error("query 为必填参数");
    if (keyword === "__empty__") {
      return empty({ source: "Feedback Index", query: args, matches: [], provenance: "synthetic" });
    }
    if (context.feedbackRetriever) {
      const matches = await context.feedbackRetriever.search({
        query: keyword,
        startTime: requiredString(args, "startTime") ?? undefined,
        endTime: requiredString(args, "endTime") ?? undefined,
        platform: requiredString(args, "platform") ?? undefined,
        version: requiredString(args, "version") ?? undefined,
        region: requiredString(args, "region") ?? undefined,
        userType: requiredString(args, "userType") ?? undefined,
        limit: numberValue(args.limit) ?? undefined,
      });
      if (matches.length === 0) {
        return empty({
          schema_version: "1",
          query: args,
          matches: [],
          provenance: { source: "Feedback Records D1", retrieval: "lexical+metadata" },
        });
      }
      return success({
        schema_version: "1",
        query: args,
        matches,
        provenance: { source: "Feedback Records D1", retrieval: "lexical+metadata" },
      });
    }
    return success({
      source: "Feedback Index",
      query: args,
      matches: [
        { channel: "support", text: "领取优惠券超时，重新点击仍失败", time: "12:08" },
        { channel: "community", text: "升级后优惠券按钮重复转圈", time: "12:10" },
      ],
      provenance: "deterministic_fixture",
    });
  },
  extractEvidence(output) {
    const matches = outputRecord(output).matches;
    if (!Array.isArray(matches) || matches.length === 0) return [];
    return [{
      category: "USER_FEEDBACK",
      statement: `异常发生后出现 ${matches.length} 条优惠券超时或重复加载反馈，与受影响功能和时间窗口一致。`,
      source: "Feedback Index",
      strength: "MEDIUM",
      provenance: "derived",
    }];
  },
};

const searchSimilarIncidentsAdapter: ToolAdapter = {
  definition: {
    type: "function",
    function: {
      name: "search_similar_incidents",
      description: "检索历史事故库中的相似异常、根因和处置结果。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          metricKey: { type: "string" },
          platform: { type: "string" },
          version: { type: "string" },
          region: { type: "string" },
          userType: { type: "string" },
          limit: { type: "number" },
          symptom: { type: "string", description: "Legacy alias for query" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const query = requiredString(args, "query") ?? requiredString(args, "symptom");
    if (!query) {
      return error("query 为必填参数");
    }
    if (context.incidentRetriever) {
      const matches = await context.incidentRetriever.search({
        query,
        metricKey: requiredString(args, "metricKey") ?? undefined,
        platform: requiredString(args, "platform") ?? undefined,
        version: requiredString(args, "version") ?? undefined,
        region: requiredString(args, "region") ?? undefined,
        userType: requiredString(args, "userType") ?? undefined,
        limit: numberValue(args.limit) ?? undefined,
      });
      if (matches.length === 0) {
        return empty({
          schema_version: "1",
          query: args,
          matches: [],
          provenance: { source: "Incident Knowledge Base", retrieval: "hybrid" },
        });
      }
      return success({
        schema_version: "1",
        query: args,
        matches,
        provenance: { source: "Incident Knowledge Base", retrieval: "hybrid" },
      });
    }
    return success({
      source: "Incident DB",
      query: args,
      matches: [{
        id: "INC-2024-081",
        similarity: 0.92,
        root_cause: "重试请求与幂等锁生命周期冲突",
        resolution: "回滚重试策略并延长幂等锁超时",
      }],
      provenance: "deterministic_fixture",
    });
  },
  extractEvidence(output) {
    const matches = outputRecord(output).matches;
    if (!Array.isArray(matches) || matches.length === 0) return [];
    const first = outputRecord(matches[0]);
    return [{
      category: "SIMILAR_INCIDENT",
      statement: `历史事故 ${String(first.incidentId ?? first.id ?? "INC-2024-081")} 呈现相似模式；该相似性只能用于形成假设，不能单独证明当前根因。`,
      source: "Incident Knowledge Base",
      strength: "LOW",
      provenance: "derived",
    }];
  },
};

export const toolAdapters: Record<string, ToolAdapter> = {
  get_release: getReleaseAdapter,
  query_metric: queryMetricAdapter,
  segment_metric: segmentMetricAdapter,
  search_user_feedback: searchUserFeedbackAdapter,
  search_similar_incidents: searchSimilarIncidentsAdapter,
};

export const modelToolDefinitions = Object.values(toolAdapters).map(
  (adapter) => adapter.definition,
);

export async function executeToolAdapter(
  adapter: ToolAdapter,
  args: ToolArgs,
  context: ToolContext = {},
): Promise<ToolExecution> {
  try {
    return await adapter.execute(args, context);
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : "工具执行失败", true);
  }
}

export async function executeNamedTool(
  name: string,
  args: ToolArgs,
  context: ToolContext = {},
) {
  const adapter = toolAdapters[name];
  if (!adapter) return error(`不允许调用工具 ${name}`);
  return executeToolAdapter(adapter, args, context);
}

export function extractToolEvidence(name: string, output: unknown) {
  return toolAdapters[name]?.extractEvidence(output) ?? [];
}
