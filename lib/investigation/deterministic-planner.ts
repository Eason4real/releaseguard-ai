import type { InvestigationPlanner, PlannerContext } from "./planner";
import { getActiveHypotheses, getPendingEvidence } from "./hypothesis-invariants";

export class DeterministicInvestigationPlanner implements InvestigationPlanner {
  readonly type = "DETERMINISTIC" as const;

  async plan(context: PlannerContext) {
    const aggregate = context.aggregate;
    const event = aggregate.riskEvent;
    const release = aggregate.release;
    const completed = aggregate.toolCalls.filter((call) => call.proposedActionId === null);
    const step = completed.length;

    if (!event || !release) {
      return {
        type: "STOP_INCONCLUSIVE" as const,
        reason: "缺少 RiskEvent 或 Release 上下文",
        rationale: "统计事件或发布记录不完整，无法开始可靠调查。",
      };
    }

    const assessable = getActiveHypotheses(aggregate);
    if (aggregate.hypotheses.length === 0) {
      return {
        type: "CREATE_HYPOTHESES" as const,
        hypotheses: [
          {
            statement: "Android 7.3.0 的重试改动与幂等锁生命周期冲突，导致优惠券领取失败。",
            supportIf: "异常集中于 7.3.0，且发布改动、分群和当前用户体验与重试锁冲突一致。",
            refuteIf: "旧版本同幅下降，或当前事件证据显示不存在重试锁冲突。",
          },
          {
            statement: "第三方依赖故障导致多个 Android 版本同步领券失败。",
            supportIf: "新旧版本同步下降，并存在跨版本的外部依赖故障信号。",
            refuteIf: "异常只集中于 7.3.0，旧版本控制组保持稳定。",
          },
          {
            statement: "成功事件漏报导致领券指标出现假性下降。",
            supportIf: "业务结果和用户体验正常，但成功事件记录缺失。",
            refuteIf: "用户反馈和分群指标都显示真实领取失败。",
          },
        ],
        rationale: "先建立发布回归、外部依赖和数据质量三个可区分的竞争假设。",
      };
    }

    const pending = getPendingEvidence(aggregate);
    if (pending.length > 0) {
      const relationFor = (
        category: string,
        statement: string,
      ): "SUPPORTS" | "CONTRADICTS" | "NEUTRAL" => {
        if (/重试|幂等锁/.test(statement)) {
          return [
            "RELEASE_CHANGE",
            "PRODUCT_METRIC",
            "SEGMENT_METRIC",
            "USER_FEEDBACK",
            "SIMILAR_INCIDENT",
          ].includes(category) ? "SUPPORTS" : "NEUTRAL";
        }
        if (/第三方|外部依赖/.test(statement)) {
          return category === "SEGMENT_METRIC" ? "CONTRADICTS" : "NEUTRAL";
        }
        if (/漏报|假性下降/.test(statement)) {
          return category === "USER_FEEDBACK" ? "CONTRADICTS" : "NEUTRAL";
        }
        if (/新用户|地区|region|US/i.test(statement) && category === "SEGMENT_METRIC") {
          return "SUPPORTS";
        }
        return "NEUTRAL";
      };
      return {
        type: "ASSESS_EVIDENCE" as const,
        assessments: pending.map((evidence) => ({
          evidenceId: evidence.id,
          relations: assessable.map((hypothesis) => ({
            targetHypothesisId: hypothesis.id,
            relation: relationFor(evidence.category, hypothesis.statement),
            explanation: `根据 ${evidence.category} 当前事件证据，显式评价该证据与假设的关系。`,
          })),
        })),
        rationale: "在继续调用工具前，批量评价全部新 Evidence 对每个 Active Hypothesis 的影响。",
      };
    }

    if (assessable.length === 0) {
      return {
        type: "STOP_INCONCLUSIVE" as const,
        reason: "所有竞争假设均已被当前证据否定",
        rationale: "现有工具无法形成新的可验证假设，安全停止调查。",
      };
    }

    const targetHypothesisIds = assessable.map((item) => item.id);
    const testIntent = targetHypothesisIds.length > 1 ? "DISCRIMINATE" as const : "SUPPORT" as const;

    if (context.trigger === "HUMAN_HYPOTHESIS" || context.trigger === "HUMAN_MESSAGE") {
      const dimension = /地区|region|美国|US/i.test(context.humanMessage ?? "")
        ? "region"
        : "user_type";
      return {
        type: "CALL_TOOL" as const,
        toolName: "segment_metric",
        targetHypothesisIds,
        testIntent,
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
        targetHypothesisIds,
        testIntent,
        arguments: { release_id: release.id },
        rationale: "先确认发布版本与高风险变更模块。",
      },
      {
        type: "CALL_TOOL" as const,
        toolName: "query_metric",
        targetHypothesisIds,
        testIntent,
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
        targetHypothesisIds,
        testIntent,
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
        targetHypothesisIds,
        testIntent,
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
        targetHypothesisIds,
        testIntent: "SUPPORT" as const,
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
    const selectedHypothesis = [...assessable]
      .sort((left, right) => right.supportScore - left.supportScore)[0];
    const supportingEvidence = aggregate.hypothesisEvidenceLinks
      .filter((link) =>
        link.hypothesisId === selectedHypothesis.id && link.relation === "SUPPORTS")
      .map((link) => aggregate.evidence.find((item) => item.id === link.evidenceId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const evidenceIds = (...categories: string[]) => supportingEvidence
      .filter((item) => categories.includes(item.category))
      .map((item) => item.id);
    return {
      type: "FINALIZE" as const,
      selectedHypothesisId: selectedHypothesis.id,
      diagnosis: {
        summary: "指标异常时间、版本改动和用户反馈形成交叉证据；历史事故仅用于支持假设。",
        claims: [
          {
            type: "ROOT_CAUSE" as const,
            statement: selectedHypothesis.statement,
            evidenceIds: supportingEvidence
              .filter((item) => item.category !== "SIMILAR_INCIDENT")
              .map((item) => item.id),
          },
          {
            type: "CAUSAL_STEP" as const,
            statement: "Android 7.3.0 的服务端立即重试改动会与幂等锁生命周期发生冲突。",
            evidenceIds: evidenceIds("RELEASE_CHANGE"),
          },
          {
            type: "AFFECTED_METRIC" as const,
            statement: "coupon_claim_success_rate 从基线水平显著下降。",
            evidenceIds: evidenceIds("PRODUCT_METRIC"),
          },
          {
            type: "AFFECTED_SEGMENT" as const,
            statement: "影响集中在 platform=Android、app_version=7.3.0。",
            evidenceIds: evidenceIds("SEGMENT_METRIC"),
          },
          {
            type: "LIMITATION" as const,
            limitationType: "SCOPE_LIMITATION" as const,
            statement: "现有分析仅覆盖 Android 7.3.0，无法判断其他历史版本。",
            evidenceIds: [],
          },
        ],
      },
      disposition: "FIX" as const,
      rationale: "指标、版本、分群和用户反馈已形成交叉证据，历史事故仅作辅助。",
    };
  }
}
