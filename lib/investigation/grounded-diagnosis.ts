import {
  evidenceFamily,
  isCurrentIncidentEvidence,
  isImpactEvidence,
  isMechanismEvidence,
} from "./confidence";
import type { GroundedDiagnosisDraft } from "./planner";
import type {
  DiagnosisLimitationType,
  DiagnosisDisposition,
  Evidence,
  Hypothesis,
  InvestigationAggregate,
  Severity,
} from "./types";

export type GroundedDiagnosisProposal = {
  selectedHypothesisId: string;
  diagnosis: GroundedDiagnosisDraft;
  disposition: DiagnosisDisposition;
};

export type ValidatedGroundedDiagnosis = GroundedDiagnosisProposal & {
  selectedHypothesis: Hypothesis;
  evidenceByClaim: Map<number, Evidence[]>;
};

const criticalClaimTypes = new Set([
  "ROOT_CAUSE",
  "CAUSAL_STEP",
  "AFFECTED_METRIC",
  "AFFECTED_SEGMENT",
]);

const normalizeStatement = (value: string) => value
  .trim()
  .toLocaleLowerCase()
  .replace(/[\s。！？,.!?;；:：'"“”‘’`]/g, "");

const limitationBoundaryPatterns: Record<DiagnosisLimitationType, RegExp[]> = {
  DATA_GAP: [
    /^(?:当前|目前|现阶段)?(?:没有|缺少|尚无|未获得|数据不足|样本不足)/,
    /^(?:currently )?(?:missing|no |insufficient|unavailable data)/i,
  ],
  SCOPE_LIMITATION: [
    /^(?:当前|目前|现有|本次)?(?:数据|样本|反馈|分析|证据).*(?:仅|只)(?:覆盖|包含|来自)/,
    /^(?:current |existing )?(?:data|sample|feedback|analysis|evidence).*(?:only covers|is limited to)/i,
  ],
  UNRESOLVED_UNCERTAINTY: [
    /^(?:当前|目前|现阶段)?(?:仍|尚)?(?:无法|不能|尚不能|未能)(?:确认|判断|排除|验证)/,
    /^(?:currently )?(?:cannot|unable to|not yet able to) (?:confirm|determine|exclude|verify)/i,
  ],
  OBSERVABILITY_LIMITATION: [
    /^(?=.*(?:不可用|不可观测|未接入|无法访问|缺少监控|缺少日志|缺少\s*trace))(?=.*(?:无法|不能|尚不能|难以))/i,
    /^(?=.*(?:unavailable|unobservable|not instrumented|not accessible|missing (?:logs|traces|monitoring)))(?=.*(?:cannot|unable|difficult))/i,
  ],
};

const criticalAssertionPatterns = [
  /根因(?:就是|是|为|来自|可能是)|root cause\s+(?:is|was|may be)/i,
  /\S+(?:导致|造成|引发|使得?)\S*(?:下降|上升|失败|异常|中断|超时|受损)|\b(?:causes?|caused|leads? to|resulted in)\b/i,
  /(?:指标|转化率?|成功率?|错误率|metric|conversion|success rate).*(?:下降|上升|异常).*(?:来自|由于|因为|caused|due to)/i,
  /(?:\S+(?:用户|人群|分群)|segment).*(?:是|为).*(?:主要)?受影响|(?:主要)?受影响(?:用户|人群|分群|segment).*(?:是|为)/i,
];

const boundedText = (value: string, label: string) => {
  const text = value.trim();
  if (!text) throw new Error(`${label} 不能为空。`);
  if (text.length > 2_000) throw new Error(`${label} 不能超过 2000 个字符。`);
  return text;
};

const validateLimitation = (
  claim: Extract<GroundedDiagnosisDraft["claims"][number], { type: "LIMITATION" }>,
) => {
  const boundaryStatement = claim.statement.trim().replace(/[。.!?！？]+$/, "");
  if (
    /[。！？!?;；]/.test(boundaryStatement)
    || /(?:但|但是|不过|然而|\bbut\b|\bhowever\b)/i.test(boundaryStatement)
  ) {
    throw new Error(
      "INVALID_LIMITATION_SHAPE: LIMITATION 必须是单一边界声明，不得追加或转折引入事实结论。",
    );
  }
  if (criticalAssertionPatterns.some((pattern) => pattern.test(claim.statement))) {
    throw new Error(
      "LIMITATION_CONTAINS_CRITICAL_ASSERTION: LIMITATION 不得承载根因、因果机制、指标变化或受影响分群事实。",
    );
  }
  const patterns = limitationBoundaryPatterns[claim.limitationType];
  if (!patterns || !patterns.some((pattern) => pattern.test(claim.statement.trim()))) {
    throw new Error(
      "INVALID_LIMITATION_BOUNDARY: LIMITATION statement 必须与 limitationType 对应，并明确表达数据、范围、不确定性或可观测性边界。",
    );
  }
};

export function validateGroundedDiagnosis(
  aggregate: InvestigationAggregate,
  proposal: GroundedDiagnosisProposal,
): ValidatedGroundedDiagnosis {
  const selectedHypothesis = aggregate.hypotheses.find((item) =>
    item.id === proposal.selectedHypothesisId);
  if (!selectedHypothesis || selectedHypothesis.runId !== aggregate.run.id) {
    throw new Error("INVALID_SELECTED_HYPOTHESIS: selectedHypothesisId 不属于当前 Run。");
  }
  if (selectedHypothesis.status === "REJECTED") {
    throw new Error("REJECTED_HYPOTHESIS: REJECTED Hypothesis 不得 Finalize。");
  }
  if (
    !["SUPPORTED", "CONFIRMED"].includes(selectedHypothesis.status)
    || !["MEDIUM", "HIGH"].includes(selectedHypothesis.confidence)
  ) {
    throw new Error(
      "HYPOTHESIS_NOT_FINALIZABLE: 只有服务端评定为 SUPPORTED/CONFIRMED 且至少 MEDIUM 的 Hypothesis 可以 Finalize。",
    );
  }

  boundedText(proposal.diagnosis.summary, "Diagnosis summary");
  if (proposal.diagnosis.claims.length === 0 || proposal.diagnosis.claims.length > 30) {
    throw new Error("INVALID_DIAGNOSIS_CLAIMS: Diagnosis 必须包含 1–30 个 Claim。");
  }
  const rootCauseClaims = proposal.diagnosis.claims.filter((claim) =>
    claim.type === "ROOT_CAUSE");
  if (rootCauseClaims.length !== 1) {
    throw new Error("ROOT_CAUSE_REQUIRED: Diagnosis 必须且只能包含一个 ROOT_CAUSE Claim。");
  }
  if (
    normalizeStatement(rootCauseClaims[0].statement)
    !== normalizeStatement(selectedHypothesis.statement)
  ) {
    throw new Error(
      "ROOT_CAUSE_HYPOTHESIS_MISMATCH: ROOT_CAUSE 必须明确采用 selected Hypothesis 的 statement。",
    );
  }

  const evidenceById = new Map(aggregate.evidence.map((item) => [item.id, item]));
  const relationByEvidenceId = new Map(
    aggregate.hypothesisEvidenceLinks
      .filter((item) => item.hypothesisId === selectedHypothesis.id)
      .map((item) => [item.evidenceId, item.relation]),
  );
  const evidenceByClaim = new Map<number, Evidence[]>();

  for (const [index, claim] of proposal.diagnosis.claims.entries()) {
    boundedText(claim.statement, `Diagnosis claim ${index + 1}`);
    if (claim.type === "LIMITATION") validateLimitation(claim);
    const uniqueEvidenceIds = new Set(claim.evidenceIds);
    if (claim.evidenceIds.length > 50) {
      throw new Error("CLAIM_EVIDENCE_LIMIT: 一个 Claim 最多引用 50 条 Evidence。");
    }
    if (uniqueEvidenceIds.size !== claim.evidenceIds.length) {
      throw new Error("DUPLICATE_CLAIM_EVIDENCE: 一个 Claim 不得重复引用同一 Evidence。");
    }
    if (criticalClaimTypes.has(claim.type) && uniqueEvidenceIds.size === 0) {
      throw new Error(`UNGROUNDED_CRITICAL_CLAIM: ${claim.type} 必须引用 Evidence。`);
    }
    const citedEvidence = [...uniqueEvidenceIds].map((evidenceId) => {
      const item = evidenceById.get(evidenceId);
      if (!item || item.runId !== aggregate.run.id) {
        throw new Error("CROSS_RUN_EVIDENCE: Claim 引用了不存在或其他 Run 的 Evidence。");
      }
      return item;
    });
    evidenceByClaim.set(index, citedEvidence);

    if (criticalClaimTypes.has(claim.type)) {
      const relations = citedEvidence.map((item) => relationByEvidenceId.get(item.id));
      if (relations.some((relation) => !relation)) {
        throw new Error(
          "UNASSESSED_CLAIM_EVIDENCE: 关键 Claim 引用了未对 selected Hypothesis 显式评价的 Evidence。",
        );
      }
      if (!relations.some((relation) => relation === "SUPPORTS")) {
        throw new Error(
          "UNSUPPORTED_CLAIM_EVIDENCE: 关键 Claim 至少需要一条对 selected Hypothesis 为 SUPPORTS 的 Evidence，不能仅依赖 CONTRADICTS 或 NEUTRAL。",
        );
      }
    }

    if (claim.type === "AFFECTED_METRIC" && !citedEvidence.some(isImpactEvidence)) {
      throw new Error("INVALID_METRIC_GROUNDING: AFFECTED_METRIC 必须引用指标 Evidence。");
    }
    if (
      claim.type === "AFFECTED_SEGMENT"
      && !citedEvidence.some((item) => item.category === "SEGMENT_METRIC")
    ) {
      throw new Error("INVALID_SEGMENT_GROUNDING: AFFECTED_SEGMENT 必须引用分群 Evidence。");
    }
  }

  const rootCauseIndex = proposal.diagnosis.claims.findIndex((claim) =>
    claim.type === "ROOT_CAUSE");
  const rootCauseEvidence = evidenceByClaim.get(rootCauseIndex) ?? [];
  const supportingRootEvidence = rootCauseEvidence.filter((item) =>
    relationByEvidenceId.get(item.id) === "SUPPORTS");
  const currentRootEvidence = supportingRootEvidence.filter(isCurrentIncidentEvidence);
  if (currentRootEvidence.length === 0) {
    throw new Error(
      "RAG_ONLY_ROOT_CAUSE: ROOT_CAUSE 必须由当前事件的 SUPPORTS Evidence 支撑，历史记忆不能单独定因。",
    );
  }
  if (selectedHypothesis.confidence === "HIGH") {
    const families = new Set(currentRootEvidence.map(evidenceFamily));
    if (families.size < 2 || !currentRootEvidence.some(isImpactEvidence)) {
      throw new Error(
        "ROOT_CAUSE_GROUNDING_INCOMPLETE: HIGH 根因必须引用至少两个当前事件 Evidence family，并包含影响证据。",
      );
    }
  }
  if (
    selectedHypothesis.status === "CONFIRMED"
    && !currentRootEvidence.some(isMechanismEvidence)
  ) {
    throw new Error(
      "ROOT_CAUSE_MECHANISM_REQUIRED: CONFIRMED 根因必须引用 mechanism-level Evidence。",
    );
  }

  return { ...proposal, selectedHypothesis, evidenceByClaim };
}

export function diagnosisSeverity(hypothesis: Hypothesis): Severity {
  if (hypothesis.confidence === "HIGH") return "HIGH";
  if (hypothesis.confidence === "MEDIUM") return "MEDIUM";
  return "LOW";
}

export function dispositionRecommendation(disposition: DiagnosisDisposition) {
  switch (disposition) {
    case "FIX":
      return "创建受控修复任务，由工程团队实施并在上线后验证恢复。";
    case "ROLLBACK":
      return "建议评估并执行受控回滚；当前系统不会自动操作生产环境。";
    case "ESCALATE":
      return "升级给工程或 SRE 团队继续处理，并保留当前证据链。";
    case "OBSERVE":
      return "继续观察关键指标和用户反馈，不执行生产变更。";
  }
}
