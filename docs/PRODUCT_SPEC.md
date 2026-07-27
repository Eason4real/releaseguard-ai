# AI Release Intelligence Agent — Product Spec

## 1. Product Positioning

**Product name:** AI Release Intelligence Agent

**Primary users:**
- Product Manager
- Product Owner
- Release Owner

**Collaborating users:**
- Engineering
- SRE
- Data / Analytics

This product is **not** a general AI SRE or infrastructure debugging agent.

Its purpose is to help product teams answer:

1. Did this release cause a product problem?
2. Which business metrics changed?
3. Which users, platforms, versions, or regions were affected?
4. What did affected users experience?
5. Is the problem correlated with the release?
6. What changed in the release?
7. What are the competing root-cause hypotheses?
8. Which evidence supports or contradicts each hypothesis?
9. Should the team Observe, Fix, Rollback, or Escalate?
10. After a fix, did the product actually recover?

### Product boundary

The investigation scope is:

Product Metrics  
→ User Feedback  
→ Release Change  
→ Limited Technical Signals  
→ PM Decision

The MVP should **not** attempt to replace SRE or perform deep infrastructure debugging.

Out of scope for MVP:
- Kubernetes remediation
- SSH / shell-based infrastructure repair
- auto-scaling or infra tuning
- database repair
- full distributed-system debugging
- autonomous production rollback without approval

---

## 2. Core User Journey

Release  
→ Risk Detection  
→ Investigation Run  
→ Seed Evidence  
→ Investigation Plan  
→ Hypotheses  
→ Tool Investigation  
→ Evidence Validation  
→ Structured Diagnosis  
→ Proposed Action  
→ Human Approval  
→ Action Execution  
→ Re-verification  
→ Incident Memory

---

## 3. Risk Detection

The LLM should **not** decide whether a metric is statistically abnormal.

Risk detection is deterministic.

### MVP detection approach

Use:

- hard rules
- dynamic baseline
- minimum sample size
- persistence requirement

Example:

- metric bucket: 5 minutes
- compare current value with historical baseline
- anomaly threshold: configurable per metric
- trigger only if anomaly persists for 3 consecutive buckets
- ignore insufficient sample sizes

Example:

payment_conversion normally = 23%–25%

Current:
- 18:00: 19%
- 18:05: 18%
- 18:10: 17%

If the threshold is exceeded for all three buckets, create a `RiskEvent`.

### Principle

**The statistical system decides: “Is there an anomaly?”**

**The Agent decides: “Why is there an anomaly?”**

---

## 4. Investigation Scope

### Product evidence

Examples:
- active_sessions
- add_to_cart_rate
- checkout_conversion
- payment_success_rate
- order_conversion
- refund_rate

### User evidence

Examples:
- feedback volume
- sentiment
- feedback themes
- affected user journeys
- representative feedback samples

### Release evidence

Examples:
- release version
- rollout time
- platform
- feature flags
- PRs
- commits
- changed modules

### Limited technical evidence

Examples:
- error summary
- service health summary
- Sentry-like errors
- selected logs
- selected traces

The MVP should stop at a useful technical signal.

Example acceptable conclusion:

> Android v8.4.0 payment conversion dropped after release. The issue is strongly correlated with a payment callback change and elevated Payment Service errors.

The MVP does not need to continue debugging JVM heap, Kubernetes scheduling, or infrastructure internals.

---

## 5. Agent Decision Space

The system controls:

- maximum investigation iterations
- visible tools
- tool permissions
- context budget
- duplicate call handling
- retries
- stagnation detection
- approval requirements
- action execution boundaries

The Agent decides:

- what competing hypotheses exist
- which hypothesis is most useful to test next
- which metric dimension to segment by
- whether feedback should be investigated
- whether release changes should be inspected
- whether historical incidents are relevant
- what evidence distinguishes H1 from H2
- when evidence is sufficient
- whether the result is inconclusive
- which action to recommend

---

## 6. Risk Decision Policy

The Agent recommendation should use a controlled set:

### OBSERVE

Use when:
- impact is small
- data is noisy
- evidence is insufficient
- the metric is recovering naturally

### FIX

Use when:
- root cause is reasonably clear
- issue is real
- immediate rollback is not justified
- a targeted engineering fix is appropriate

### ROLLBACK

Use when:
- impact is severe
- release correlation is strong
- evidence strongly implicates the release
- continuing the rollout creates material business/user risk

### ESCALATE

Use when:
- impact is significant
- root cause remains unclear
- evidence conflicts
- data quality is poor
- broader engineering/SRE intervention is required

### Important rule

The LLM must not freely invent arbitrary actions outside the supported policy.

---

## 7. Confidence Policy

Do not allow the LLM to generate fake precision such as `87%` unless that number is derived from a defined scoring model.

For MVP use:

- HIGH
- MEDIUM
- LOW

Confidence should consider:

- evidence coverage
- evidence strength
- alternative hypotheses eliminated
- timeline correlation
- segment correlation
- data quality
- unresolved contradictions

Example:

HIGH:
- multiple independent evidence sources agree
- key alternatives were tested and contradicted
- timeline matches the release
- affected segment matches the release scope

LOW:
- only correlation exists
- critical data is missing
- multiple hypotheses remain plausible

---

## 8. Human Approval

Read-only investigation tools can run autonomously.

Examples:
- query_metric
- segment_metric
- search_feedback
- get_release
- get_release_changes

Action tools require approval.

Examples:
- create_github_issue
- send_slack_alert

Future examples:
- rollback_release
- disable_feature_flag

Approval should apply to the **specific proposed tool call**, not to the whole incident.

Example:

Tool:
`create_github_issue`

Arguments:
- repo
- title
- severity
- description

The PM sees:
- proposed action
- business impact
- supporting evidence
- exact parameters

Then:
- Approve
- Reject

After either decision, the same Investigation Run resumes.

---

## 9. Re-verification

The workflow does not end when an issue is created.

After a fix or rollback:

WAITING_VERIFICATION  
→ check relevant metrics  
→ compare against baseline  
→ check persistence  
→ check feedback trend  
→ resolve or reopen

Recommended statuses:

- RESOLVED
- PARTIALLY_RECOVERED
- NOT_RECOVERED
- INCONCLUSIVE

MVP recovery criteria should be configurable.

Example:

payment_success_rate:
- back within acceptable baseline band
- sustained for 30 minutes
- no continuing abnormal feedback increase

---

## 10. MVP Product Surfaces

### Overview

Show:
- active releases
- open risk events
- unresolved investigations
- severity
- current status

### Releases

Show:
- version
- release time
- platform
- rollout state
- linked incidents

### Risk Events

Show:
- abnormal metric
- deviation
- affected segment
- trigger reason

### Investigation

Tabs or sections:

- Overview
- Plan
- Hypotheses
- Evidence
- Activity
- Diagnosis
- Actions
- Verification

### Approval

Show:
- proposed tool
- arguments
- reason
- business impact
- evidence
- Approve / Reject

### Incident Memory

Show:
- previous incidents
- root causes
- resolution
- similarities

### Eval

Show:
- test cases
- pass/fail
- root-cause accuracy
- evidence recall
- tool efficiency
- token/cost metrics

---

## 11. MVP Non-goals

Do not prioritize:

- multi-agent orchestration
- dozens of integrations
- complex enterprise RBAC
- SSO
- Kubernetes remediation
- generic enterprise chat
- full observability replacement
- arbitrary autonomous write actions
- forced use of LangChain
- forced use of MCP
- knowledge graphs
- RAPTOR-style advanced retrieval

The MVP should prove:

**A single investigation agent can reliably investigate product release risk with evidence, controlled tools, human approval, and re-verification.**
