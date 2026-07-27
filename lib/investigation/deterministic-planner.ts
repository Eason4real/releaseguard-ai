import { fixtureDiagnosis } from "./runtime";
import type { InvestigationPlanner, PlannerContext } from "./planner";

export class DeterministicInvestigationPlanner implements InvestigationPlanner {
  readonly type = "DETERMINISTIC" as const;

  async plan(context: PlannerContext) {
    const aggregate = context.aggregate;
    const event = aggregate.riskEvent;
    const release = aggregate.release;
    const completed = aggregate.toolCalls.filter((call) => call.proposedActionId === null);
    const step = completed.length;
    const hypothesisDrafts = step === 0
      ? [{ statement: "Android 7.3.0 的重试改动与幂等锁生命周期冲突，导致优惠券领取失败。" }]
      : undefined;

    if (!event || !release) {
      return {
        type: "STOP_INCONCLUSIVE" as const,
        reason: "缺少 RiskEvent 或 Release 上下文",
        rationale: "统计事件或发布记录不完整，无法开始可靠调查。",
      };
    }

    if (context.trigger === "HUMAN_HYPOTHESIS" || context.trigger === "HUMAN_MESSAGE") {
      const dimension = /地区|region|美国|US/i.test(context.humanMessage ?? "")
        ? "region"
        : "user_type";
      return {
        type: "CALL_TOOL" as const,
        toolName: "segment_metric",
        arguments: {
          metric_key: event.metricKey,
          start_time: event.firstBreachedAt,
          end_time: event.lastBreachedAt,
          filters: { platform: "Android", appVersion: "7.3.0" },
          dimension,
          limit: 10,
        },
        rationale: dimension === "region"
          ? "根据产品经理方向追加地区分群验证。"
          : "根据产品经理假设追加用户类型分群验证。",
      };
    }

    const decisions = [
      {
        type: "CALL_TOOL" as const,
        toolName: "get_release",
        arguments: { release_id: release.id },
        rationale: "先确认发布版本与高风险变更模块。",
        hypothesisDrafts,
      },
      {
        type: "CALL_TOOL" as const,
        toolName: "query_metric",
        arguments: {
          metric_key: event.metricKey,
          start_time: event.firstBreachedAt,
          end_time: event.lastBreachedAt,
          filters: event.filters,
          granularity_minutes: 5,
          include_baseline: true,
        },
        rationale: "核对异常窗口、样本量和动态基线。",
      },
      {
        type: "CALL_TOOL" as const,
        toolName: "segment_metric",
        arguments: {
          metric_key: event.metricKey,
          start_time: event.firstBreachedAt,
          end_time: event.lastBreachedAt,
          filters: { platform: "Android" },
          dimension: "app_version",
          limit: 10,
        },
        rationale: "比较版本分群，确认影响是否集中在 7.3.0。",
      },
      {
        type: "CALL_TOOL" as const,
        toolName: "search_user_feedback",
        arguments: {
          query: "优惠券领取超时 重复加载 Android 7.3.0",
          platform: "Android",
          version: "7.3.0",
          limit: 5,
        },
        rationale: "检索当前异常窗口内的用户反馈，寻找行为侧证据。",
      },
      {
        type: "CALL_TOOL" as const,
        toolName: "search_similar_incidents",
        arguments: {
          query: "优惠券领取失败 服务端重试 幂等锁",
          metricKey: event.metricKey,
          platform: "Android",
          limit: 5,
        },
        rationale: "检索历史事故作为辅助模式证据，并保留来源信息。",
      },
    ];
    if (step < decisions.length) return decisions[step];
    return {
      type: "FINALIZE" as const,
      diagnosis: fixtureDiagnosis(),
      rationale: "指标、版本、分群和用户反馈已形成交叉证据，历史事故仅作辅助。",
    };
  }
}
