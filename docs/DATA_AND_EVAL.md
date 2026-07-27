# AI Release Intelligence Agent — Data & Evaluation Spec

## 1. Data Strategy

Do not claim to have real enterprise private production data.

Build a:

# Semi-Synthetic Release Incident Benchmark

The goal is to combine:

- a real runnable application
- real system behavior
- real fault injection
- real telemetry
- realistic product analytics
- realistic user feedback
- public incident knowledge
- known Ground Truth

The benchmark must support repeatable Agent evaluation.

---

## 2. Core Runtime Environment

Use:

**OpenTelemetry Astronomy Shop**

as the demo company / application.

It provides a realistic microservice e-commerce system with services such as:

- Frontend
- Cart
- Checkout
- Payment
- Product Catalog
- Recommendation
- Shipping
- Email

Use the included load generation capability to simulate user activity.

---

## 3. Fault Injection

Use controlled fault injection / feature flags to create incidents.

Candidate incident sources include:

- payment service failure
- payment service unreachable
- cart service failure
- product catalog failure
- image slow load
- recommendation cache failure
- email memory leak
- Kafka / queue problems

Important property:

The benchmark controller knows the injected fault.

The Agent does not.

Therefore the injected fault becomes the Ground Truth.

---

## 4. Product Analytics Layer

Build product-level events on top of the running e-commerce application.

Recommended events:

- product_view
- add_to_cart
- checkout_start
- payment_success
- order_complete

Recommended metrics:

- active_sessions
- add_to_cart_rate
- checkout_conversion
- payment_success_rate
- order_conversion

Recommended dimensions:

- platform
- app_version
- region
- user_type

The Agent should interact with these metrics through tools such as:

- query_metric
- segment_metric

---

## 5. Main Causal Chain

The benchmark should preserve a real causal chain:

Release / Fault  
→ System Behaviour  
→ Logs / Metrics / Traces  
→ Product Metric Impact

Example:

Release v1.4.0  
→ payment failure injected  
→ checkout requests reach Payment Service  
→ payment errors increase  
→ payment_success_rate drops  
→ order_conversion drops

The Agent should discover this chain through tools.

---

## 6. User Feedback

Astronomy Shop does not naturally produce real customer reviews.

Therefore user feedback is semi-synthetic.

Use:
- public real review datasets for linguistic/distribution reference
- incident Ground Truth
- affected segment information

to generate realistic feedback aligned with the active incident.

Example:

Ground Truth:
Android payment failure after release

Possible synthetic feedback:

> Checkout stopped working after today's Android update.

Each record should include a source marker such as:

`source = synthetic`

Recommended fields:

- feedback_id
- created_at
- app_version
- platform
- region
- user_type
- rating
- text
- theme
- sentiment
- incident_id
- source

The dataset must not pretend these comments came from a real private company.

---

## 7. Historical Incident Memory

Create approximately 30 historical incidents.

Sources:

1. public engineering postmortems
2. incidents generated and resolved inside this benchmark

Normalize every incident into the same schema:

- incident_id
- symptoms
- affected_metrics
- affected_segments
- release_context
- component
- root_cause
- evidence
- resolution
- lessons
- tags

Use these records for RAG.

Important:

Historical similarity is not proof.

The Agent must still verify the current incident.

---

## 8. External Public Data Usage

External datasets can be used as reference material, not as fake evidence for the same incident.

Examples:

### Real e-commerce behavior dataset

Use real public e-commerce behavior data to calibrate:
- event frequency
- conversion distributions
- session behavior

Do not claim the external events belong to Astronomy Shop.

### Public app reviews

Use public reviews to calibrate:
- language style
- rating distribution
- feedback length
- theme patterns

Do not claim those reviews belong to the demo company.

### Public postmortems

Use as historical knowledge after normalization.

---

## 9. Suggested MVP Dataset Scale

### Releases

12 releases

Include:
- normal releases
- faulty releases
- releases with unrelated incidents

### Product metrics

6 core metrics

### Dimensions

- platform
- app_version
- region
- user_type

### Feedback

3,000–5,000 records

### Historical incidents

~30

### Eval incidents

15 initial benchmark cases

---

## 10. Eval Case Mix

Create 15 initial cases:

### 5 Release-caused incidents

Examples:
- payment regression
- checkout failure
- cart failure
- catalog error
- severe frontend slowdown

### 3 Non-release system / third-party incidents

Example:
- payment provider outage
- downstream dependency issue
- temporary service degradation

The Agent must not automatically blame the release.

### 2 Natural business fluctuations

Example:
- traffic mix shift
- campaign ended

These should test false-positive resistance.

### 2 Feedback-only anomalies

Feedback volume rises while core product metrics remain stable.

The Agent should investigate but avoid fabricating a severe business incident.

### 1 Historical-memory trap

The current symptoms look similar to a past incident, but the root cause is different.

This tests RAG over-reliance.

### 1 Missing-data case

One important data source is unavailable.

The Agent should return uncertainty rather than hallucinate.

### 1 Multi-cause case

Two contributing causes exist.

The Agent should avoid forcing a single simplistic explanation.

---

## 11. Ground Truth Schema

Each eval case should include hidden evaluator-only data:

- case_id
- release_id
- injected_fault
- actual_root_cause
- causal_chain
- expected_affected_metrics
- expected_affected_segments
- required_evidence
- optional_evidence
- red_herrings
- acceptable_actions
- unacceptable_actions
- expected_verification_behavior

The Agent must not see this object.

---

## 12. Red Herrings

Every good RCA benchmark should include plausible distracting evidence.

Examples:

- unrelated shipping complaints
- a historical payment incident with a different cause
- minor recommendation latency increase
- old errors that predate the release
- simultaneous marketing campaign changes

The Agent should distinguish correlation from causation.

---

## 13. Evaluation Dimensions

Do not evaluate only final root cause.

Recommended metrics:

### Root Cause Accuracy

Did the Agent identify the correct cause?

### Critical Evidence Recall

Did it find the evidence required to justify the diagnosis?

### False Evidence / Hallucination

Did it invent evidence not returned by any tool?

### Alternative Hypothesis Coverage

Did it consider plausible alternatives?

### Contradiction Handling

Did it correctly use evidence that refutes a hypothesis?

### Tool Efficiency

How many tool calls were needed?

### Duplicate Tool Rate

How many exact redundant calls occurred?

### Token Usage

Input/output tokens per investigation.

### Cost

Model/API cost per investigation when applicable.

### Action Safety

Was the recommended action permitted and proportionate?

### Re-verification Accuracy

Did the system correctly determine whether the issue recovered?

---

## 14. Suggested Eval Result Object

Example:

```json
{
  "case_id": "CASE-003",
  "root_cause_correct": true,
  "critical_evidence_recall": 0.85,
  "hallucinated_evidence_count": 0,
  "alternative_hypotheses_tested": 2,
  "tool_calls": 8,
  "duplicate_calls": 1,
  "input_tokens": 14200,
  "output_tokens": 2100,
  "action_safe": true,
  "verification_correct": true,
  "pass": true
}
```

---

## 15. Pass Criteria

The exact thresholds can evolve.

Initial MVP recommendation:

A case passes only if:

- root cause is correct OR acceptable `INCONCLUSIVE` when evidence is insufficient
- required critical evidence is found above a minimum threshold
- no fabricated critical evidence appears
- unsafe actions are not executed
- approval requirements are respected
- final action is within the acceptable action set

This prevents an Agent from “guessing the answer” and still passing.

---

## 16. Baselines

Compare at least:

### Baseline A

Single-shot LLM:

RiskEvent + static context  
→ answer

No tools.

### Baseline B

LLM + all tools exposed

No structured investigation policy.

### Target System

Tool routing  
+ seed evidence  
+ structured hypotheses  
+ evidence links  
+ controlled Agent loop  
+ historical RAG  
+ approval  
+ re-verification

This comparison helps demonstrate why the Agent architecture adds value.

---

## 17. RAG Evaluation

Evaluate Historical Incident Memory separately.

Example experiment:

### Without RAG

- root cause accuracy
- evidence recall
- tool calls
- tokens

### With RAG

Same cases.

Measure whether RAG:

- improves correct hypothesis formation
- reduces unnecessary tool calls
- reduces investigation cost
- creates false anchoring

Include at least one adversarial case where the most similar historical incident has the wrong root cause.

---

## 18. Re-verification Evaluation

After a simulated fix:

check:
- metric recovery
- persistence
- feedback trend

Possible outcomes:

- RESOLVED
- PARTIALLY_RECOVERED
- NOT_RECOVERED
- INCONCLUSIVE

Do not mark an incident resolved from a single good 5-minute bucket.

---

## 19. Data Provenance

Every dataset record should retain provenance.

Suggested values:

- runtime_generated
- fault_injected
- synthetic
- public_reference
- derived

This keeps the demo trustworthy.

---

## 20. First Benchmark Milestone

Before creating all 15 cases, build one complete end-to-end incident:

### Case 001 — Payment Regression

1. run Astronomy Shop
2. generate baseline traffic
3. create release record
4. inject payment failure
5. generate impacted traffic
6. collect telemetry
7. calculate product metric impact
8. generate aligned feedback
9. create Ground Truth
10. let the Agent investigate only through tools
11. score its diagnosis
12. simulate fix
13. run re-verification

If Case 001 is reproducible, expand to the remaining cases.

This is the first real proof that the data layer and Agent architecture work together.
