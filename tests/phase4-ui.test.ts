import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = () => readFile("app/page.tsx", "utf8");

test("Phase 4 UI renders claim evidence and marks historical RAG provenance", async () => {
  const source = await pageSource();
  assert.match(source, /diagnosisClaimEvidenceLinks/);
  assert.match(source, /Evidence 引用/);
  assert.match(source, /Historical Memory \/ RAG/);
  assert.match(source, /Supporting Evidence/);
  assert.match(source, /Contradicting Evidence/);
  assert.match(source, /Neutral Evidence/);
});

test("Phase 4 UI renders deterministic verification outcomes and policy evidence", async () => {
  const source = await pageSource();
  assert.match(source, /verificationPolicySnapshots/);
  assert.match(source, /verificationEvaluations/);
  assert.match(source, /requiredConsecutiveBuckets/);
  for (const outcome of ["RESOLVED", "PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"]) {
    assert.match(source, new RegExp(outcome));
  }
});

test("Phase 4 UI suppresses retry and reopen controls for stale, failed and resolved attempts", async () => {
  const source = await pageSource();
  assert.match(source, /const stale = latest\.attempt !== Math\.max/);
  assert.match(source, /const canRetry = !stale/);
  assert.match(source, /latest\.status !== "FAILED"/);
  assert.match(source, /latest\.status !== "RESOLVED"/);
});

test("Phase 4 UI truthfully labels fixture, live, fallback and approved GitHub writes", async () => {
  const source = await pageSource();
  assert.match(source, /FIXTURE/);
  assert.match(source, /FALLBACK/);
  assert.match(source, /REAL WRITE/);
  assert.match(source, /OpenAI-compatible LLM/);
  assert.match(source, /尚未确认修复上线/);
  assert.doesNotMatch(source, /自动修复|自动部署|实时生产数据/);
});
