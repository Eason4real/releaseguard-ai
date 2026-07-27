import assert from "node:assert/strict";
import { DeterministicEmbeddingProvider } from "../lib/retrieval/embedding";
import { incidentFixtures } from "../lib/retrieval/fixtures";
import { InMemoryIncidentRetriever } from "../lib/retrieval/local-retrievers";
import { cosineSimilarity, tokenize } from "../lib/retrieval/tokenizer";

const cases = [
  ["立即重试 幂等锁 优惠券超时", "INC-2024-081"],
  ["支付网关区域抖动 多版本领券失败", "INC-2025-014"],
  ["iOS 指标漏报 业务订单正常", "INC-2025-033"],
  ["新用户实验没有优惠券资格", "INC-2025-047"],
  ["CDN 缓存旧资格规则", "INC-2025-052"],
  ["token refresh retry storm login", "INC-2025-061"],
  ["US new user coupon inventory exhausted", "INC-2025-073"],
  ["图片资源太大 页面加载慢但领取成功", "INC-2025-088"],
  ["订单幂等键格式不兼容", "INC-2026-003"],
  ["弱网低端机客户端超时过短", "INC-2026-011"],
  ["风控阈值误伤高频领取用户", "INC-2026-018"],
  ["消息队列积压 发券延迟", "INC-2026-024"],
  ["灰度百分比解析错误导致全量发布", "INC-2026-031"],
  ["营销活动请求增长但成功率正常", "INC-2026-039"],
  ["success_code 字段不兼容 服务端成功客户端失败", "INC-2026-050"],
] as const;

const documents = incidentFixtures.map((incident) => ({
  id: incident.incidentId,
  text: `${incident.title} ${Object.values(incident.sections).join(" ")} ${incident.components.join(" ")}`,
}));
const embedding = new DeterministicEmbeddingProvider();
const documentVectors = await embedding.embed(documents.map((item) => item.text));
const hybrid = new InMemoryIncidentRetriever();

const ranks = {
  lexical: [] as number[],
  vector: [] as number[],
  hybrid: [] as number[],
};

for (const [query, expected] of cases) {
  const queryTokens = new Set(tokenize(query));
  const lexical = documents.map((item) => ({
    id: item.id,
    score: tokenize(item.text).filter((token) => queryTokens.has(token)).length,
  })).sort((left, right) => right.score - left.score);
  const [queryVector] = await embedding.embed([query]);
  const vector = documents.map((item, index) => ({
    id: item.id,
    score: cosineSimilarity(queryVector, documentVectors[index]),
  })).sort((left, right) => right.score - left.score);
  const hybridMatches = await hybrid.search({ query, limit: 10 });
  ranks.lexical.push(lexical.findIndex((item) => item.id === expected) + 1);
  ranks.vector.push(vector.findIndex((item) => item.id === expected) + 1);
  ranks.hybrid.push(hybridMatches.findIndex((item) => item.incidentId === expected) + 1);
}

const metrics = (values: number[]) => ({
  recallAt1: values.filter((rank) => rank === 1).length / values.length,
  recallAt3: values.filter((rank) => rank > 0 && rank <= 3).length / values.length,
  mrr: values.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / values.length,
});

const report = {
  cases: cases.length,
  lexical: metrics(ranks.lexical),
  vector: metrics(ranks.vector),
  hybrid: metrics(ranks.hybrid),
};
console.log(JSON.stringify(report, null, 2));
assert.ok(report.hybrid.recallAt1 >= 0.8, "Hybrid Recall@1 must be at least 0.80");
assert.ok(report.hybrid.recallAt3 >= 0.95, "Hybrid Recall@3 must be at least 0.95");
assert.ok(report.hybrid.mrr >= 0.85, "Hybrid MRR must be at least 0.85");
