# AI Release Intelligence Agent — Agent Architecture

## 1. Architecture Principle

The LLM is not the Agent system.

The LLM decides:

> Given current evidence, what should I investigate next?

The Agent Runtime controls:

- available tools
- permissions
- retries
- duplicate calls
- context budget
- state transitions
- approvals
- stopping conditions
- persistence
- auditability

The MVP should use:

**Single Investigation Agent + Multiple Atomic Tools + Structured State + Evidence + Approval**

Do not introduce Multi-Agent unless one agent becomes genuinely constrained by context or specialization.

---

## 2. Core Runtime Objects

### InvestigationRun

Represents one end-to-end investigation.

Suggested statuses:

- PENDING
- RUNNING
- WAITING_APPROVAL
- ACTION_EXECUTING
- WAITING_VERIFICATION
- RESOLVED
- INCONCLUSIVE
- FAILED

Suggested fields:

- id
- risk_event_id
- release_id
- status
- started_at
- completed_at
- current_iteration
- stop_reason
- summary

---

### AgentIteration

Represents one LLM reasoning/action cycle.

Fields:

- id
- investigation_run_id
- iteration_number
- input_summary
- requested_tool_calls
- resulting_evidence_ids
- created_at

Do not persist private chain-of-thought.

Persist only auditable outputs such as:
- hypotheses
- selected actions
- observations
- rationale summary
- evidence links

---

### InvestigationPlan

Example steps:

1. Verify anomaly
2. Identify affected segment
3. Correlate with release
4. Analyze user feedback
5. Inspect release changes
6. Test alternative causes
7. Produce diagnosis

Step status:

- PENDING
- RUNNING
- COMPLETED
- SKIPPED

---

### Hypothesis

Example:

`Android v8.4.0 introduced a payment regression.`

Fields:

- id
- investigation_run_id
- statement
- support_if
- refute_if
- status
- confidence

Status:

- SUPPORTED
- REJECTED
- UNRESOLVED

Confidence:

- HIGH
- MEDIUM
- LOW

---

### ToolCall

Fields:

- id
- investigation_run_id
- iteration_id
- tool_name
- normalized_arguments
- signature
- status
- requested_at
- completed_at
- requires_approval

Statuses:

- REQUESTED
- RUNNING
- SUCCESS
- EMPTY
- ERROR
- WAITING_APPROVAL
- DENIED
- CANCELLED
- CACHED

---

### ToolResult

Raw or normalized result returned by a tool.

ToolResult answers:

> What did the machine/API/database return?

Do not confuse this with Evidence.

---

### Evidence

Evidence answers:

> What does the tool result mean for this investigation?

Example:

- type: metric
- source: product_analytics
- claim: Android v8.4.0 payment conversion dropped significantly
- observed: 0.17
- baseline: 0.24
- change_pct: -29.2
- sample_size: 18422
- time_range
- source_tool_call_id

---

### EvidenceLink

Links evidence to a hypothesis.

Relation:

- SUPPORTS
- CONTRADICTS
- NEUTRAL

Strength:

- STRONG
- MEDIUM
- WEAK

This is important to avoid confirmation bias.

The Agent should collect both supporting and contradicting evidence.

---

### Diagnosis

Final output must be structured.

Suggested schema:

- root_cause
- causal_chain
- affected_users
- affected_metrics
- validated_claims
- unvalidated_claims
- alternative_hypotheses
- evidence_summary
- confidence
- severity
- recommended_action

---

### ProposedAction

Examples:

- CREATE_GITHUB_ISSUE
- SEND_SLACK_ALERT

Future:
- ROLLBACK_RELEASE
- DISABLE_FEATURE_FLAG

---

### Approval

Fields:

- action_tool_call_id
- decision
- decided_by
- decided_at
- comment

Decision:
- APPROVED
- REJECTED

---

### VerificationRun

Fields:

- incident_id
- fix_time
- metric
- baseline
- observed
- recovery_status
- evidence

---

## 3. Agent Loop

High-level runtime:

RiskEvent

→ resolve available tools

→ execute deterministic seed tools

→ build investigation context

→ create/update hypotheses

→ choose tool call(s)

→ validate tool availability

→ validate arguments

→ detect duplicates

→ check permission / approval

→ execute

→ normalize ToolResult

→ extract Evidence

→ link Evidence to Hypothesis

→ append only necessary information to context

→ next iteration

→ structured diagnosis

---

## 4. Seed Evidence

Before the first LLM decision, automatically collect data that is always required.

Example RiskEvent:

- metric = payment_conversion
- release_id = R104

Seed calls:

- get_release(R104)
- query_metric(before_release)
- query_metric(after_release)

Store results in two places:

1. Agent context
2. Structured Evidence store

This reduces wasted model calls.

---

## 5. Stopping Conditions

The Agent should not run indefinitely.

### NORMAL_COMPLETE

The Agent has sufficient evidence.

### MAX_ITERATIONS

MVP recommendation: 10 iterations.

### STAGNATION

If 2 consecutive iterations generate no new evidence or only exact duplicate tool calls:

- stop tool access
- force structured diagnosis using existing evidence

### DEGRADED_FAILURE

If the LLM/API fails after evidence has already been collected:

- preserve investigation state
- mark investigation incomplete
- expose retry
- do not discard previous evidence

---

## 6. Tool Registry vs Visible Tools

All registered tools should not automatically be visible to the model.

Separate:

**Tool Registry**
- everything the system supports

from:

**Visible Tool Set**
- tools relevant to the current investigation

Example:

RiskEvent:
`payment_conversion down`

Visible tools might be:

- query_metric
- segment_metric
- search_feedback
- get_release
- get_release_changes
- search_similar_incidents

Do not expose:
- send_slack_alert
- create_github_issue
- unrelated technical tools

until the relevant phase.

---

## 7. MVP Tool Set

### Measure

#### query_metric

Purpose:

> What happened to a metric?

Example input:

```json
{
  "metric": "payment_conversion",
  "start_time": "2026-07-25T17:00:00",
  "end_time": "2026-07-25T20:00:00",
  "filters": {
    "platform": "android",
    "app_version": "8.4.0"
  },
  "granularity": "15m"
}
```

Example result:

```json
{
  "status": "success",
  "metric": "payment_conversion",
  "value": 0.17,
  "baseline": 0.24,
  "change_pct": -29.2,
  "sample_size": 18422
}
```

---

#### segment_metric

Purpose:

> Which segment explains the anomaly?

Supported dimensions:

- platform
- app_version
- region
- user_type

Example flow:

overall payment_conversion = -14%

→ segment by platform

Android = -27%
iOS = -1%

→ within Android segment by version

8.4.0 = -42%
8.3.9 = -2%

This is a core example of Agent autonomy.

---

### Experience

#### search_feedback

Return aggregated information first.

Suggested result:

```json
{
  "status": "success",
  "total": 847,
  "themes": [
    {
      "theme": "payment_failed",
      "count": 421,
      "share": 0.497
    }
  ],
  "sentiment": {
    "negative": 0.81
  },
  "samples": [
    "..."
  ]
}
```

Do not return hundreds or thousands of raw comments by default.

---

#### get_feedback_samples

Use only after the Agent identifies a useful theme or segment.

Arguments might include:

- theme
- version
- platform
- time_range
- limit

---

### Change

#### get_release

Return:
- release id
- version
- release time
- platform
- rollout information
- feature flags

---

#### get_release_changes

Return:
- related PRs
- commits
- changed modules
- change summaries

---

#### search_code_change

Use for deeper inspection of a suspected component.

Read-only in MVP.

---

### Memory

#### search_similar_incidents

Retrieve historical incidents based on current symptoms.

Historical incidents are useful for hypothesis formation only.

They are not proof of current root cause.

---

#### get_incident_detail

Return structured details for a selected historical incident.

---

### Action

#### create_github_issue

Requires approval.

#### send_slack_alert

Requires approval by default in MVP.

---

## 8. Tool Contract

All tools should return one of:

- SUCCESS
- EMPTY
- ERROR

### EMPTY

Do not return only `[]`.

Example:

```json
{
  "status": "empty",
  "tool": "search_feedback",
  "query": {
    "version": "8.4.0",
    "platform": "ios"
  },
  "reason": "No matching feedback found",
  "suggested_next": [
    "remove platform filter",
    "expand time range"
  ]
}
```

### ERROR

Return enough information for the Agent to self-correct:

- attempted query
- arguments
- failure reason
- retryable
- suggested correction

Principle:

**Tool failed != Agent failed.**

---

## 9. Duplicate Tool Calls

Build a canonical signature:

`tool_name + normalized(arguments)`

If the exact call was already executed:

- do not execute again
- return cached result
- mark ToolCall as CACHED

If two consecutive iterations produce no fresh evidence:

- trigger STAGNATION

---

## 10. Context Management

Do not put all raw data into the model.

### Product principle

Large data processing happens in:
- SQL
- analytics layer
- tool implementation

The LLM receives:
- summary
- relevant breakdowns
- representative samples

### Progressive Retrieval

Example:

search_feedback
→ aggregated themes

Agent identifies `payment_failed`

→ get_feedback_samples(theme="payment_failed", limit=10)

This same progressive-disclosure principle should apply to:
- feedback
- logs
- traces
- historical incidents
- skills

---

## 11. Skills

Skills describe **how to investigate**.

Tools describe **what actions are possible**.

### release-risk-investigation

Suggested process:

1. Scope
2. Measure
3. Segment
4. Timeline
5. Release correlation
6. Feedback
7. Release changes
8. Form hypotheses
9. Test hypotheses
10. Diagnose
11. Recommend action

Important rules:

- aggregate before samples
- create 1–3 competing hypotheses
- define what supports each hypothesis
- define what refutes each hypothesis
- actively seek contradicting evidence
- stop when evidence is sufficient

---

### feedback-investigation

Flow:

feedback volume  
→ themes  
→ affected segment  
→ representative samples  
→ correlate with metric/release

---

### release-change-investigation

Flow:

release  
→ PR  
→ commit  
→ changed modules  
→ affected component  
→ incident timeline correlation

---

## 12. MCP

MCP is optional.

Do not use MCP only to claim the project uses MCP.

Potential future use:

GitHub MCP

Investigation phase:
- read-only tools
- list commits
- read PR
- get commit
- search code

Action phase after approval:
- issue write

Use least privilege.

---

## 13. RAG

RAG is used for:

**Historical Incident Memory**

Pipeline:

resolved incident  
→ structured summary  
→ embedding  
→ vector database  
→ search_similar_incidents

Historical incident schema:

- symptoms
- affected_metric
- affected_segment
- release
- component
- root_cause
- evidence
- resolution
- lessons

RAG should help form hypotheses.

It must not directly prove a root cause.

---

## 14. Approval Runtime

Action tool requested:

→ ToolCall = WAITING_APPROVAL  
→ InvestigationRun = WAITING_APPROVAL

UI shows:
- tool
- exact arguments
- reason
- business impact
- evidence

### Approve

→ execute tool  
→ ToolResult SUCCESS/ERROR  
→ resume same Investigation Run

### Reject

→ create ToolResult indicating execution denied  
→ resume same Investigation Run  
→ allow Agent to choose another action

---

## 15. Auditability

Persist:

- investigation state
- plan
- hypotheses
- tool calls
- tool results
- evidence
- evidence links
- diagnosis
- approvals
- action execution
- verification

Do not expose or rely on private hidden chain-of-thought.

The UI should explain decisions through:

**Hypothesis + Evidence + Observation + Result**

not raw internal reasoning tokens.
