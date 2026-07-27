import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryFeedbackRetriever,
  InMemoryIncidentRetriever,
} from "../lib/retrieval/local-retrievers";
import { executeNamedTool } from "../lib/investigation/tools";

test("search_user_feedback performs real lexical and metadata retrieval", async () => {
  const retriever = new InMemoryFeedbackRetriever();
  const matches = await retriever.search({
    query: "优惠券 领取 超时 Android",
    platform: "Android",
    version: "7.3.0",
    limit: 10,
  });
  assert.ok(matches.length >= 3);
  assert.ok(matches.every((item) => item.platform === "Android" && item.version === "7.3.0"));
  assert.ok(matches.every((item) => item.provenance.sourceReference.startsWith("feedback://")));
  assert.ok(matches.some((item) => item.matchedTerms.length > 0));
});

test("hybrid incident retrieval combines lexical, vector and metadata signals", async () => {
  const retriever = new InMemoryIncidentRetriever();
  const matches = await retriever.search({
    query: "优惠券立即重试与幂等锁生命周期冲突",
    platform: "Android",
    metricKey: "coupon_claim_success_rate",
    limit: 5,
  });
  assert.equal(matches[0].incidentId, "INC-2024-081");
  assert.equal(matches[0].retrievalSignals.retrievalMode, "HYBRID_LOCAL");
  assert.ok(matches[0].retrievalSignals.lexicalRank);
  assert.ok(matches[0].retrievalSignals.vectorRank);
  assert.ok(matches[0].sourceDocument.startsWith("incident://"));
  assert.ok(matches[0].chunkId);
});

test("hybrid retrieval resists a keyword-similar but causally different incident", async () => {
  const retriever = new InMemoryIncidentRetriever();
  const payment = await retriever.search({
    query: "支付网关区域抖动 Android 多版本优惠券失败",
    platform: "Android",
    metricKey: "coupon_claim_success_rate",
    region: "US",
    limit: 3,
  });
  assert.equal(payment[0].incidentId, "INC-2025-014");
  assert.notEqual(payment[0].incidentId, "INC-2024-081");
});

test("formal retrieval tools return provenance instead of fixed fixtures", async () => {
  const feedback = await executeNamedTool(
    "search_user_feedback",
    {
      query: "优惠券领取超时",
      platform: "Android",
      version: "7.3.0",
      limit: 5,
    },
    { feedbackRetriever: new InMemoryFeedbackRetriever() },
  );
  assert.equal(feedback.status, "SUCCESS");
  const incidents = await executeNamedTool(
    "search_similar_incidents",
    {
      query: "重试 幂等锁 优惠券失败",
      platform: "Android",
      metricKey: "coupon_claim_success_rate",
      limit: 5,
    },
    { incidentRetriever: new InMemoryIncidentRetriever() },
  );
  assert.equal(incidents.status, "SUCCESS");
  const output = incidents.output as { matches: Array<{ retrievalSignals: unknown; sourceDocument: string }> };
  assert.ok(output.matches[0].retrievalSignals);
  assert.ok(output.matches[0].sourceDocument);
});
