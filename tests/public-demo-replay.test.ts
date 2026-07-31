import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPublicDemoReplayDefinition,
  createPublicDemoReplayState,
  getPublicDemoReplaySteps,
  publicDemoReplayReducer,
  selectPublicDemoReplay,
  type PublicDemoReplayState,
  type PublicDemoReplayStep,
} from "../lib/public-demo";

const advanceToEnd = (initial = createPublicDemoReplayState()) => {
  let state = initial;
  const steps = getPublicDemoReplaySteps(state.mode);
  while (state.cursor < steps.length - 1) state = publicDemoReplayReducer(state, { type: "NEXT" });
  return state;
};

const advanceTo = (stepId: string, mode: PublicDemoReplayState["mode"] = "NORMAL") => {
  let state = createPublicDemoReplayState(mode);
  const steps = getPublicDemoReplaySteps(mode);
  const target = steps.findIndex((step) => step.id === stepId);
  assert.notEqual(target, -1);
  while (state.cursor < target) state = publicDemoReplayReducer(state, { type: "NEXT" });
  return selectPublicDemoReplay(state);
};

test("Public Demo replay advances from IDLE through the complete VERIFIED sequence", () => {
  let state = createPublicDemoReplayState();
  assert.equal(selectPublicDemoReplay(state).stage, "IDLE");
  const stages: string[] = [];
  for (let remaining = getPublicDemoReplaySteps("NORMAL").length; remaining > 0; remaining -= 1) {
    state = publicDemoReplayReducer(state, { type: "NEXT" });
    stages.push(selectPublicDemoReplay(state).stage);
  }
  assert.deepEqual(stages, [
    "DETECTED",
    "INVESTIGATING",
    "INVESTIGATING",
    "INVESTIGATING",
    "INVESTIGATING",
    "INVESTIGATING",
    "INVESTIGATING",
    "INVESTIGATING",
    "WAITING_APPROVAL",
    "APPROVED",
    "ACTION_SIMULATED",
    "ACTION_COMPLETED",
    "VERIFIED",
  ]);
  assert.equal(state.playback, "PAUSED");
});

test("Planner iterations, decision types and authoritative budgets remain exact", () => {
  const decisions = getPublicDemoReplaySteps("NORMAL").filter((step) => step.decision);
  assert.deepEqual(decisions.map((step) => step.decision?.type), [
    "CREATE_HYPOTHESES",
    "CALL_TOOL",
    "ASSESS_EVIDENCE",
    "CALL_TOOL",
    "ASSESS_EVIDENCE",
    "CALL_TOOL",
    "ASSESS_EVIDENCE",
    "FINALIZE",
  ]);
  assert.deepEqual(decisions.map((step) => step.iteration), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(decisions.map((step) => step.decision?.modelCallOrdinal), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(decisions.map((step) => step.budget.toolCallsUsed), [0, 1, 1, 2, 2, 3, 3, 3]);
  assert.ok(decisions.every((step) => step.budget.maxModelCalls === 20));
  assert.ok(decisions.every((step) => step.budget.maxToolCalls === 10));
  assert.ok(decisions.every((step) => step.budget.maxIterations === 16));
});

test("Evidence is created only after its successful ToolCall and ToolResult", () => {
  const steps = getPublicDemoReplaySteps("NORMAL");
  const evidenceSteps = steps.filter((step) => step.evidenceCreated.length > 0);
  assert.equal(evidenceSteps.length, 3);
  for (const step of evidenceSteps) {
    assert.equal(step.toolCall?.status, "SUCCESS");
    const kinds = step.auditEvents.map((event) => event.kind);
    assert.ok(kinds.indexOf("TOOL_CALL_STARTED") < kinds.indexOf("TOOL_RESULT_RECORDED"));
    assert.ok(kinds.indexOf("TOOL_RESULT_RECORDED") < kinds.indexOf("EVIDENCE_CREATED"));
    assert.ok(step.evidenceCreated.every((item) => item.sourceTool === step.toolCall?.name));
  }
});

test("ASSESS_EVIDENCE updates the matrix with support and contradiction relations", () => {
  const release = advanceTo("assess-release");
  assert.deepEqual(release.relations.map((item) => [item.evidenceId, item.targetHypothesisId, item.relation]), [
    ["E-RELEASE", "H1", "SUPPORTS"],
  ]);
  const segment = advanceTo("assess-segment");
  assert.deepEqual(segment.relations.slice(-2).map((item) => [item.targetHypothesisId, item.relation]), [
    ["H1", "SUPPORTS"],
    ["H2", "CONTRADICTS"],
  ]);
  const feedback = advanceTo("assess-feedback");
  assert.deepEqual(feedback.relations.slice(-2).map((item) => [item.targetHypothesisId, item.relation]), [
    ["H1", "SUPPORTS"],
    ["H3", "CONTRADICTS"],
  ]);
});

test("FINALIZE is rejected by the replay validator without grounded diagnosis conditions", () => {
  const valid = getPublicDemoReplaySteps("NORMAL");
  assert.doesNotThrow(() => assertPublicDemoReplayDefinition(valid));
  const broken = structuredClone(valid) as PublicDemoReplayStep[];
  const finalize = broken.find((step) => step.decision?.type === "FINALIZE");
  assert.ok(finalize);
  finalize.outcome = {};
  assert.throws(() => assertPublicDemoReplayDefinition(broken), /FINALIZE is not grounded/);
  assert.equal(advanceTo("assess-feedback").diagnosis, null);
  assert.equal(advanceTo("finalize").diagnosis?.selectedHypothesisId, "H1");
});

test("Fault-injection rejects safely and performs one bounded repair in the same iteration", () => {
  const steps = getPublicDemoReplaySteps("FAULT_INJECTION");
  const rejected = steps.find((step) => step.id === "fault-assess-release-rejected");
  const repaired = steps.find((step) => step.id === "fault-assess-release-repaired");
  assert.ok(rejected?.decision && repaired?.decision);
  assert.equal(rejected.decision.validation.errorType, "PlannerDecisionValidationError");
  assert.equal(rejected.decision.validation.code, "INVALID_PLANNER_DECISION");
  assert.equal(rejected.decision.validation.path, "assessments[0].evidenceId");
  assert.equal(rejected.iteration, repaired.iteration);
  assert.equal(rejected.decision.modelCallOrdinal + 1, repaired.decision.modelCallOrdinal);
  assert.equal(repaired.decision.repairAttempt, 1);
  assert.equal(repaired.decision.status, "REPAIRED");
  assert.equal(rejected.toolCall, null);
  assert.deepEqual(rejected.businessObjects, []);
  assert.deepEqual(rejected.evidenceCreated, []);
  assert.equal(rejected.auditEvents.some((event) => event.kind === "DECISION_ACCEPTED"), false);
  assert.equal(repaired.auditEvents.some((event) => event.kind === "REPAIR_ATTEMPTED"), true);
  assert.equal(repaired.auditEvents.some((event) => event.kind === "DECISION_ACCEPTED"), true);
  assert.equal(steps.filter((step) => step.decision?.repairAttempt === 1).length, 1);
  assert.equal(steps.at(-1)?.budget.modelCallsUsed, 9);
  assert.equal(steps.at(-1)?.budget.iterationsUsed, 8);
});

test("Normal and fault-injection replay data remain isolated", () => {
  const normal = getPublicDemoReplaySteps("NORMAL");
  const fault = getPublicDemoReplaySteps("FAULT_INJECTION");
  assert.equal(normal.some((step) => step.decision?.status === "REJECTED"), false);
  assert.equal(normal.some((step) => step.decision?.repairAttempt === 1), false);
  assert.equal(fault.some((step) => step.decision?.status === "REJECTED"), true);
  assert.equal(fault.length, normal.length + 1);
});

test("Autoplay and single-step execution produce the same terminal snapshot", () => {
  const stepped = advanceToEnd();
  let autoplay = publicDemoReplayReducer(createPublicDemoReplayState(), { type: "PLAY" });
  while (autoplay.playback === "PLAYING") autoplay = publicDemoReplayReducer(autoplay, { type: "NEXT" });
  assert.deepEqual(selectPublicDemoReplay(autoplay), selectPublicDemoReplay(stepped));
  assert.equal(autoplay.playback, "PAUSED");
  assert.equal(selectPublicDemoReplay(autoplay).stage, "VERIFIED");
});

test("Previous, next, reset and deterministic hydration remain stable", () => {
  let state = createPublicDemoReplayState();
  state = publicDemoReplayReducer(state, { type: "NEXT" });
  state = publicDemoReplayReducer(state, { type: "NEXT" });
  const second = selectPublicDemoReplay(state);
  state = publicDemoReplayReducer(state, { type: "PREVIOUS" });
  state = publicDemoReplayReducer(state, { type: "NEXT" });
  assert.deepEqual(selectPublicDemoReplay(state), second);
  assert.deepEqual(selectPublicDemoReplay(structuredClone(state)), second);
  const ordered = second.auditEvents.map((event) => [event.offsetSeconds, event.tieBreaker, event.id]);
  assert.deepEqual(ordered, [...ordered].sort((left, right) =>
    Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1])
    || String(left[2]).localeCompare(String(right[2]))));
  state = publicDemoReplayReducer(state, { type: "RESET" });
  assert.deepEqual(state, createPublicDemoReplayState());
  assert.equal(selectPublicDemoReplay(state).stage, "IDLE");
});

test("Public Demo source has no persistence, credentials, private API or external link surface", async () => {
  const source = await readFile("app/public-demo.tsx", "utf8");
  const replaySource = await readFile("lib/public-demo-replay.ts", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|EventSource|sessionStorage|localStorage/i);
  assert.doesNotMatch(source, /apiKey|authorization|type=["']password|<input|<textarea|<a\b|https?:\/\//i);
  assert.doesNotMatch(replaySource, /https?:\/\/|github\.com|apiKey|authorization|sessionStorage|localStorage/i);
  assert.match(source, /Agent 调查回放/);
  assert.match(source, /故障注入回放/);
  assert.match(source, /DEMO-WORK-ITEM-001/);
  assert.match(source, /不调用真实模型、GitHub 或 D1/);
  assert.match(styles, /@media \(max-width: 430px\)/);
  assert.match(styles, /\.replay-command-button\.reset/);
  assert.doesNotMatch(styles, /\.replay-command-button\.reset[^\{]*\{[^\}]*display\s*:\s*none/);
});
