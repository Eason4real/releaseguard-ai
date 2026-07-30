# Investigation Benchmark Dataset Specification

## Scope

This document specifies a future Investigation Benchmark dataset. It does not create benchmark
cases, Dev or Holdout fixtures, a live Agent provider, or benchmark results. Phase 1C.1 produces no
accuracy claim. The benchmark is intended to answer whether ReleaseGuard AI can investigate a new,
unseen product release incident, identify the root cause at the granularity supported by current
evidence, select relevant evidence, avoid unsupported claims, resist distractors, stop when evidence
is insufficient, and control investigation cost.

The benchmark is not a prompt-format test, a UI test, a collection of unit tests, a replay of the
Android 7.3.0 demo, or proof that the deterministic fixture pipeline represents Agent quality.

## Current Capability Audit

### Contract and pipeline

The existing `InvestigationBenchmarkCase` is sufficient for the core executable case:

- benchmark metadata: opaque case ID, title, category, and difficulty;
- Agent input: incident ID and question, optional production-shaped `RiskEvent` and `Release`, and
  opaque data-source references;
- evaluation data: canonical root cause, accepted aliases, and required, supporting, and distractor
  evidence IDs;
- result normalization: structured diagnosis claims, citations, model/tool counts, optional token
  usage, and optional duration;
- deterministic scoring and aggregation for root-cause top-1 accuracy, Evidence Precision,
  Unsupported Claim Rate, and investigation cost.

The execution boundary correctly keeps benchmark metadata and Ground Truth out of `agentInput`.
The runner, normalizer, and scorer are provider-independent. The current deterministic provider is
only a pipeline test adapter and does not run the Agent.

The core case contract does not carry dataset version, split, source provenance, template-family
identity, difficulty rationale, or integrity hashes. Those fields belong in a harness-only dataset
manifest, not in Agent input. Phase 1C.2 must define and validate that manifest before authoring a
governed dataset. No TypeScript change is needed to specify it in Phase 1C.1.

There is also no live benchmark provider yet. A future provider must resolve opaque fixture
references into the same stores/retrievers used by the production Agent, run the shared AgentLoop,
and return measured runtime output. Until that exists, cases can test the deterministic pipeline but
cannot produce an Agent benchmark metric.

### Agent-observable sources

The current Agent has five read-only investigation tools:

| Tool | Agent-observable facts | Valid benchmark use |
| --- | --- | --- |
| `get_release` | version, platform, release time, rollout status/percentage, feature flags, changed modules | release correlation, rollout and declared-change context; never causation alone |
| `query_metric` | product metric buckets, weighted summaries, baseline, time window, filters | anomaly shape, timing, sample size, control metrics |
| `segment_metric` | metric breakdown by platform, app version, region, or user type | affected and unaffected cohorts, negative evidence |
| `search_user_feedback` | time- and metadata-filtered feedback records | current symptoms and user-visible error patterns |
| `search_similar_incidents` | historical incident matches and provenance | hypothesis generation only; similarity is not current-incident proof |

`RiskEvent` can provide metric, direction, baseline, deviation, sample size, breached buckets, time,
and product filters. `Release` can provide release/rollout context. Product analytics supports only
platform, app version, region, and user type segmentation. Benchmark fixtures may populate
analytics, release, feedback, and historical-incident stores with production-shaped data.

### Unsupported investigation surfaces

The benchmark data-source union declares `technical_signal`, but no current Agent tool can query an
opaque technical-signal reference. The Agent has no log, trace, database query/lock, connection-pool,
configuration-center, feature-flag assignment, third-party status, CPU, memory, container, network,
queue-depth, or general file-reading tool. A fixture reference by itself is not evidence and must not
be placed in a prompt as hidden context.

Therefore Phase 1C.2 must not author a positive diagnosis that requires any of those unavailable
signals. Specific claims such as "migration X held lock Y", "pod memory exhaustion", or "provider Z
returned a particular internal error" are unsolvable today unless the current tools expose adequate
current-event evidence at a defensible, coarser level. Otherwise the correct case outcome must be
insufficient evidence. Database and infrastructure remain reserved contract categories, not eligible
positive-root-cause families in the initial dataset. Adding tools to unlock them is a separate product
phase.

## Benchmark Objectives

Every dataset release must primarily measure:

1. root-cause identification at the evidence-supported granularity;
2. relevant evidence selection;
3. evidence-grounded final claims;
4. resistance to realistic noise, distractors, and historical near matches;
5. correct insufficient-evidence behavior; and
6. investigation efficiency using actual model calls, tool calls, measured tokens when available,
   and measured duration when available.

## Three-Plane Dataset Model

The authored dataset must preserve the existing execution boundary:

1. **Benchmark Metadata Plane:** case ID, title, taxonomy, difficulty and rationale, split,
   provenance, template family, authoring notes, dataset version, and integrity metadata.
2. **Agent Execution Plane:** incident ID/question, `RiskEvent`, `Release`, and opaque references to
   data that current tools can query. Only this plane may reach the Agent.
3. **Evaluation Plane:** canonical root cause, aliases, evidence labels, expected outcome, and scorer.

Provider access and Agent access are not equivalent. A provider may use an opaque execution key and
harness manifest to assemble stores, but it must inject only `agentInput` and ordinary tool results
into the Agent execution context.

## Initial Taxonomy

The initial executable taxonomy is deliberately narrower than the domain's full incident taxonomy.
It uses existing `BenchmarkCaseCategory` values and admits only cases that current tools can solve.

| Authoring family | Contract category | Inclusion boundary |
| --- | --- | --- |
| Code / release regression | `release_regression` | Affected-version and timing evidence plus current metrics/feedback can distinguish the release from controls; changed modules alone are insufficient. |
| Configuration / feature flag / rollout | `configuration` | The relevant rollout or declared flag context is visible in `get_release`, and current metrics/segments/feedback establish impact. Hidden config values are forbidden. |
| Upstream dependency | `upstream_dependency` | Conditionally eligible only when current-event product metrics and user-visible provider/error evidence identify the dependency family; historical similarity cannot be required proof. |
| Feedback or measurement defect | `user_feedback` | Feedback and product/control metrics establish a user-visible or measurement problem rather than a hidden technical mechanism. |
| Non-release / benign anomaly | `unknown` | Evidence reliably excludes the latest release and supports a non-incident or non-release explanation such as expected demand/noise at the observable product level. |
| Insufficient evidence | `insufficient_evidence` | Available tools cannot reliably choose among plausible causes; the correct result is an explicit evidence boundary, not a guessed mechanism. |

The following are reserved and receive zero positive cases in the initial blueprint:

- `database`: no database observation tool;
- `infrastructure`: no resource, container, or network observation tool.

Traffic/capacity is not a standalone initial category. Observable demand shifts may appear under
non-release/benign anomaly; capacity or throttling mechanisms that require resource telemetry are
insufficient-evidence cases. Feature-flag and rollout cases are folded into configuration because
the release record exposes only declared flag and rollout context.

## Difficulty Rubric

Difficulty is author-assigned from observable case structure, never from expected model behavior.
Score each dimension before assigning a level:

| Dimension | 0 points | 1 point | 2 points |
| --- | --- | --- | --- |
| Distractors | 0-1 | 2-3 | 4 or more |
| Plausible hypotheses | one dominant | two plausible | three or more, or two tightly competing |
| Required source kinds | one | two | three or more |
| Causal exposure | direct current evidence | evidence must be joined | only elimination/negative evidence, or correct insufficiency |
| Temporal trap | none | weak correlation | latest release is a strong but false lead |
| Completeness/conflict | complete and consistent | one noncritical gap | material gap or conflict that must constrain the answer |

Apply these deterministic rules:

- **EASY (0-3):** no dimension scores 2; evidence is complete; there is one dominant hypothesis;
  and at least one current-event source directly supports the answer.
- **MEDIUM (4-7):** at least two dimensions score 1 or more; at least two source kinds or two
  plausible hypotheses are required; evidence remains sufficient for a defensible answer.
- **HARD (8-12):** score is at least 8; at least three source kinds and two plausible hypotheses are
  present; and the case includes a strong temporal trap, material negative evidence, or a deliberate
  insufficiency boundary. A hard positive case must still be tool-solvable.

Authors record the six component scores and rationale in the manifest. Difficulty, its component
scores, and rationale never enter Agent input.

## Dataset Size and Split

The target is 36 cases: 22 Dev and 14 Holdout. This is large enough to exercise every eligible
family in both splits and support multiple difficulty levels while remaining reviewable case by
case. It is not large enough for narrow subgroup claims or statistical significance claims; report
raw counts and uncertainty alongside aggregate percentages.

### Category distribution

| Category | Dev | Holdout | Total |
| --- | ---: | ---: | ---: |
| Code / release regression | 5 | 3 | 8 |
| Configuration / feature flag / rollout | 4 | 3 | 7 |
| Upstream dependency (conditional) | 3 | 2 | 5 |
| Feedback or measurement defect | 3 | 2 | 5 |
| Non-release / benign anomaly | 3 | 2 | 5 |
| Insufficient evidence | 4 | 2 | 6 |
| **Total** | **22** | **14** | **36** |

### Difficulty distribution

| Difficulty | Dev | Holdout | Total | Share |
| --- | ---: | ---: | ---: | ---: |
| Easy | 7 | 3 | 10 | 27.8% |
| Medium | 10 | 7 | 17 | 47.2% |
| Hard | 5 | 4 | 9 | 25.0% |
| **Total** | **22** | **14** | **36** | **100%** |

The Holdout distribution intentionally emphasizes Medium and Hard cases. Each eligible category
must include at least one Medium or Hard Holdout case. The exact matrix is frozen in the dataset
manifest; totals may change only through a versioned specification amendment.

## Dev and Holdout Policy

Dev supports repeated local evaluation, debugging, and Agent/tool iteration. Its case outputs and
Ground Truth may be inspected by developers, but never injected into execution.

Holdout is used only for frozen baselines, important version checkpoints, and externally reported
performance. Developers must not tune the Agent case by case from Holdout failures. Holdout cases
must be independently authored, reviewed, and frozen; they cannot be renamed or numerically altered
Dev cases.

### Split leakage rules

The following are prohibited across Dev and Holdout:

1. the same incident with a different ID;
2. the same causal story with only service, version, region, or metric names replaced;
3. the same evidence graph with only values or timestamps changed;
4. a shared complete fixture or copied fixture subtree;
5. the same template-family ID or a parent/child template relationship;
6. answer-bearing title, taxonomy, ID, source reference, file path, evidence ID, or metadata;
7. benchmark taxonomy or difficulty injected into Agent context;
8. authoring notes, provenance, expected answer, evidence labels, or Holdout outcomes accessible to
   the Agent; and
9. adapting a Holdout case after observing an Agent-specific failure without a dataset version bump.

Semantic similarity is allowed: two cases may both involve release regressions or databases as a
hypothesis. Template leakage exists when the mechanism, evidence topology, exclusion path, and
answer can be transferred by surface substitution. Authors assign a harness-only `templateFamilyId`
and document mechanism, evidence topology, and decisive exclusion path. No template family may
cross splits. A reviewer must also inspect near-neighbor text and evidence-graph similarity; an
automated similarity score is a triage signal, not the final decision.

## Ground Truth Authoring

Every case must define:

- one stable canonical root-cause ID;
- a concise canonical root-cause statement at no finer granularity than the evidence supports;
- narrowly equivalent aliases, excluding broader or weaker hypotheses;
- required evidence IDs;
- all supporting evidence IDs, including every required ID; and
- distractor evidence IDs disjoint from supporting evidence.

**Required Evidence** is evidence without which the canonical cause is not sufficiently
demonstrated. At least one required item in every positive case must be current-event evidence;
historical retrieval can never be required proof.

**Supporting Evidence** strengthens the conclusion but is not necessarily sufficient alone. It may
include negative evidence that rules out a competing hypothesis when the authored interpretation is
explicit. The current scorer treats all supporting IDs as relevant for precision, so author notes
must distinguish direct, contextual, and exclusion roles without changing scorer semantics.

**Distractor Evidence** is real, retrievable, and plausibly relevant but does not support the final
cause. It must not be fabricated solely to make the Agent fail. Historical near matches and temporal
release correlation are valid distractors when their provenance and limitations are preserved.

For an insufficient-evidence case, use a stable canonical outcome representing inability to
reliably identify a root cause. Required evidence identifies the observations needed to justify the
boundary, such as conflicting segments or missing current-event data; it must not encode a hidden
technical answer. Do not author a secret "true cause" and score a guess against it.

Two reviewers must be able to explain the canonical answer and every evidence label from the
fixture contents. Disagreement blocks the case until resolved and recorded.

## Evidence Design

Positive cases should contain causal, symptom, and contextual evidence plus realistic noise.
Evidence must be obtainable through allowed tools and retain source, time, strength, and provenance.

- **Correlation is not causation:** include cases where a release is temporally close but controls,
  version segmentation, or other current evidence excludes it.
- **Multiple hypotheses:** Medium and Hard cases begin with at least two plausible explanations and
  provide evidence that discriminates between them.
- **Negative evidence:** unaffected versions, regions, cohorts, normal control metrics, and absence
  of corroborating feedback may rule out a hypothesis. Absence is evidence only when collection
  scope and data completeness make it meaningful.
- **Insufficient evidence:** conflicting, empty, low-sample, or unavailable results must sometimes
  make `INCONCLUSIVE` the correct behavior. Not every case has a unique technical cause.
- **Historical retrieval:** similar incidents are clues and distractors, never proof of the current
  root cause. At least two Hard cases should contain an adversarial historical near match.

No fixture may expose evidence classification through ordering, filenames, labels, IDs, counts, or
provider behavior. Case, source, incident, and evidence identifiers visible to execution must use
opaque numeric forms.

## Source Policy

Each manifest entry records source class, provenance, rights/license where applicable, author,
reviewers, adaptation notes, source snapshot hash, and whether any source text is Agent-visible.
Provenance stays in the Metadata Plane.

1. **Repository-native/product-native fixtures:** newly authored production-shaped releases,
   metrics, feedback, and retrieval records. They may reuse schemas and builders, not the Android
   7.3.0 story or its evidence graph.
2. **Adapted realistic incidents:** abstracted from public software incident patterns. They must be
   remodeled into facts current ReleaseGuard tools can query. Do not give the Agent an incident
   article or postmortem answer. Record source rights and transformation provenance.
3. **Fully synthetic scenarios:** authored to fill coverage gaps. Label them synthetic and never
   present them as real production incidents.

Dev and Holdout should each contain more than one source class. No public source may appear in both
splits through separate adaptations of the same incident.

## Dataset Quality Gates

All gates are hard gates before Phase 1C.2 can be frozen:

- **Coverage:** exact category blueprint is met; every eligible category appears in both splits;
  reserved categories have no misleading positive cases.
- **Balance:** no root-cause family exceeds 25% of all cases; no exact mechanism template appears
  more than twice; no case or source class dominates Holdout.
- **Difficulty:** the frozen distribution matches the blueprint, every rubric score is recorded,
  and independent reviewers agree within one level before resolving to one final label.
- **Leakage:** serialized Agent payload contains none of the forbidden metadata or Ground Truth;
  all visible IDs/references are opaque; provider tests prove the harness execution key does not
  enter Agent context.
- **Ground Truth:** contract invariants pass; every label is reviewable; positive cases have
  current-event required evidence; insufficient cases contain no secret scored cause.
- **Tool solvability:** every positive case has a documented path from current allowed tools to all
  required evidence. Reserved or unavailable signals fail the gate. Insufficient cases document
  exactly which missing/conflicting observations justify stopping.
- **Duplicate:** template families are disjoint across splits; fixture hashes are distinct; manual
  evidence-graph review and text-similarity triage find no near-duplicate transfer path.
- **Determinism:** fixture inputs, manifest, Ground Truth, expected tool outputs, and provider
  behavior are stable across two clean runs; canonical serialization hashes match.
- **Provenance:** every case and source has complete origin, rights, adaptation, and synthetic/real
  labeling; provenance is absent from Agent input unless it is ordinary tool-result provenance.
- **Pipeline:** runner, normalizer, scorer, aggregate, anti-leakage tests, and all existing project
  gates pass without changing Phase 1A metric semantics.

## Executable Governance Contract

Phase 1C.2 implements the harness-only contract under
`eval/investigation-benchmark/dataset/`. It wraps, rather than replaces,
`InvestigationBenchmarkCase`.

The manifest contains:

- `schemaVersion`, `datasetId`, `purpose`, semantic `version`, and
  `evaluationContractVersion`;
- informational `createdAt` and `updatedAt` timestamps;
- an explicitly recorded `expectedDatasetHash`;
- case entries with case ID, split, category, difficulty level and six dimensions,
  `difficultyScore`, opaque `templateFamily`, provenance, opaque fixture reference,
  required tool names, manual-review attestations, and enabled state.

`purpose` is `GOVERNED_BENCHMARK`, `GOVERNED_DEV`, or `TEST_ONLY`. The complete benchmark profile
is subject to the frozen 36-case split matrix. `GOVERNED_DEV` is a formal intermediate dataset that
must contain exactly the 22-case Dev category matrix and no Holdout entries; it must cover all three
difficulty levels with Medium as the largest group. `TEST_ONLY` exists solely so validator
regression fixtures can exercise the contract without being mistaken for Dev or Holdout benchmark
cases.

Each governed fixture embeds the existing `InvestigationBenchmarkCase` and adds harness-only
evidence observations. An observation maps an evidence ID to a source ID, current allowed tool,
`CURRENT_INCIDENT` or `HISTORICAL` scope, evidence role, and deterministic payload. An optional
evidence graph records typed relationships. `fixtureData` holds the production-shaped test world
that a future provider will resolve; the validator never injects it directly into Agent context.

### Canonical dataset hash

`calculateInvestigationBenchmarkDatasetHash` constructs a whitelist projection, serializes it with
recursively sorted object keys, and calculates SHA-256. Case entries and fixtures are sorted by
identity. Set-like arrays (tool names, review notes, aliases, evidence-label lists, data sources,
evidence observations, and graph edges) are normalized before serialization. Ordered fixture data,
such as a metric time series, retains array order because order is semantic there.

The hash includes dataset/schema/evaluation versions, purpose, every case entry and governance
field, provenance, review attestations, the full executable case and Ground Truth, evidence
observations/graph, and fixture content. It excludes `createdAt`, `updatedAt`,
`expectedDatasetHash`, runtime results, scores, execution timestamps, and undeclared/machine-local
fields.

`lockInvestigationBenchmarkDataset` is an explicit helper that returns a detached definition with
the calculated hash recorded. It does not silently repair an input file or suppress validation.
The governed workflow is: validate the unlocked definition, explicitly lock it, then validate the
locked definition. Any semantic change makes the recorded hash stale and validation fails until an
intentional version/hash update. The validator cannot prove that a version bump accompanied a
change without a prior manifest, so release history review remains a governance requirement.

### Validator report and automatic checks

`validateInvestigationBenchmarkDataset` returns one report with `PASS`, `FAIL`, `WARN`, or
`MANUAL_REVIEW` status for manifest integrity, coverage, category balance, difficulty balance,
Ground Truth integrity, tool solvability, duplicate detection, split leakage, determinism,
provenance, and dataset hash. Every non-pass finding has a stable code, reason, and case ID when
applicable. `valid` means no `FAIL`; it does not convert warnings or required review to `PASS`.

Machine checks include:

- manifest identity/version/timestamps, unique case and fixture IDs, opaque references, fixture
  resolution, category/difficulty consistency, and execution-boundary derivation;
- provenance type/description and required public-source reference/adaptation notes;
- six difficulty dimensions, score/level mapping, and the structural EASY/MEDIUM/HARD rules;
- canonical answer/alias validity, evidence-set completeness, label disjointness, graph integrity,
  and exact answer text in identifying or execution-visible metadata;
- evidence-to-source/tool compatibility based on the names exported by the current production tool
  registry, required-tool agreement, current-event proof, and reserved unsolvable categories;
- formal 36-case coverage, category/difficulty distribution, root-cause concentration, and template
  concentration for `GOVERNED_BENCHMARK` manifests;
- cross-split template-family/reference reuse, exact fixture fingerprints, and normalized structural
  evidence-graph fingerprints; and
- repeated canonical hash stability and expected-hash verification.

### Manual-review boundary

No deterministic string rule can prove that aliases are semantically equivalent, evidence labels
are causally correct, an adapted public article did not donate its answer, a coarse observation is
sufficient at the authored root-cause granularity, or two different-looking cases are not the same
story with renamed services. Each case therefore carries explicit Ground Truth, tool-solvability,
and split-similarity review attestations. Missing attestations produce `MANUAL_REVIEW`, not `PASS`.
Same-split structural or exact fixture collisions produce `WARN`; cross-split collisions are hard
failures. Automated fingerprints are conservative triage and do not replace reviewer judgment.

### Validator-only fixtures

Phase 1C.2 test fixtures live only inside
`tests/investigation-benchmark-dataset.test.ts`. Their manifest purpose is `TEST_ONLY`, their URI
scheme is `test-only-fixture://`, their provenance and payload identify them as TEST ONLY, and no
runner imports them. They are not formal Dev/Holdout cases and cannot produce benchmark metrics.

## Holdout Governance

After Phase 1C.2 authoring and review:

1. freeze a versioned manifest and immutable Holdout fixture snapshot;
2. record a canonical content hash for the manifest, every fixture, and Ground Truth;
3. restrict routine development to Dev results; expose Holdout only for named checkpoints;
4. never tune from individual Holdout failures or publish case-level expected answers;
5. if a Holdout defect requires correction, bump the dataset version, record the reason and exact
   change, regenerate hashes, and do not compare old and new aggregate scores as the same series;
6. record every formal baseline's Agent commit, dataset version/hash, model and provider config,
   tool/runtime config, evaluation contract version, execution time, and raw report hash; and
7. preserve prior manifests and reports so a published number remains reproducible.

Holdout access control is a process boundary as well as a code boundary. A repository-visible
Holdout may still be valid for a portfolio project, but anyone who reads its Ground Truth is no
longer blind and must not claim an independently blind evaluation.

## Metric Credibility

A result may be called an Agent benchmark result only when it was produced by an Agent execution
provider, the Agent had no Ground Truth access, the dataset/version was frozen, the deterministic
scorer computed the metrics, and the complete run configuration was recorded. Synthetic provider
pipeline results are implementation tests, not Agent performance. Phase 1C.1 creates no cases and
no benchmark score.

## Formal Dataset Authoring Entry Conditions

Before any formal case is authored, the next dataset-authoring checkpoint must explicitly approve:

- the Phase 1C.2 harness-only manifest, validator, canonical hash, and report contracts;
- a fixture layout that keeps Dev and Holdout physically distinct;
- a provider plan mapping opaque source references to current analytics and retrieval stores;
- automated leakage, duplicate, Ground Truth, solvability, and determinism validation; and
- the 36-case blueprint in this document.

These entry conditions do not authorize production Agent changes, new investigation tools, real
model calls, external writes, deployment, or publication of benchmark performance.

## Governed Dev Dataset

Phase 1C.3 defines the formal Dev-only dataset under
`eval/investigation-benchmark/dataset/dev/`. Its manifest purpose is `GOVERNED_DEV`, version is
`0.1.0`, and every enabled entry has split `DEV`. It contains the specified 22 cases with category
counts 5/4/3/3/3/4 and difficulty counts 6 Easy, 11 Medium, and 5 Hard. It contains no Holdout
fixture or template allocation.

`loadInvestigationBenchmarkDevDataset` returns a detached definition assembled only from the
formal Dev authoring module. It does not scan the filesystem and cannot import validator-only test
fixtures. The Dev manifest records its canonical hash explicitly; governance tests independently
load, validate, hash, and compare the definition. This dataset is suitable for future Agent
development evaluation after an Agent execution provider exists, but construction and validation
alone produce no Agent accuracy or scorer result.
