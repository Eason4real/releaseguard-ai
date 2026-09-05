# Reproducing the ReleaseGuard Evaluation

## Requirements

- Linux/WSL, Node.js 22.13 or newer, npm, Bash, `flock`, `curl`, and GNU `timeout`.
- Repository commit and dirty-worktree state recorded in the final report.
- A DeepSeek API key stored outside the repository. Never commit or print the key.

Create `~/.config/releaseguard/live-eval.env` with mode `600`:

```bash
export LIVE_EVAL_PROVIDER="deepseek"
export LIVE_EVAL_BASE_URL="https://api.deepseek.com"
export LIVE_EVAL_MODEL="deepseek-v4-flash"
export LIVE_EVAL_API_KEY="..."
```

## Frozen inputs

```bash
source ~/.nvm/nvm.sh
cd /home/eason/projects/risk-command-center-v17
npm ci
npm run eval:dataset:freeze
sha256sum -c evaluation/dataset/SHA256SUMS
```

Do not continue if the Hash check fails. Dataset version `0.2.0` is a governed Dev set, not a
Holdout. Its 22 cases are offline reconstructions, not 22 public incidents.

## Pipeline and credential preflight

```bash
source ~/.config/releaseguard/live-eval.env
npm run eval:investigation-dev-harness
npm run eval:investigation-live -- --provider=live --preflight
```

The deterministic command validates repeatability only. It is not Agent accuracy. The Live
preflight is not benchmark-eligible and must not enter the 22-case denominator.

## Direct LLM

Run independently and preserve every JSONL record:

```bash
source ~/.config/releaseguard/live-eval.env
npm run eval:direct -- --run=1
npm run eval:direct -- --run=2
npm run eval:direct -- --run=3
```

## Current and Improved Agent

For each frozen source revision, run the existing Live harness three times:

```bash
source ~/.config/releaseguard/live-eval.env
npm run eval:investigation-live -- --provider=live
```

The command checkpoints after every case under `reports/investigation-benchmark/` and never
overwrites a completed artifact. Copy the three completed JSON reports into
`evaluation/results/raw/` with system and run-index names. Do not delete failed cases or rerun a
case merely to replace a failure. The Improved Agent must use the same Dataset Hash, model,
temperature, budgets, timeout, retries, and concurrency.

## Blind semantic review and report artifacts

After all nine complete system runs exist under `evaluation/results/raw/`:

```bash
source ~/.config/releaseguard/live-eval.env
npm run eval:judge
npm run eval:summary
```

The judge hides system names, deterministically shuffles the nine outputs for each case, and saves
its complete input, response, reason, confidence, and identity mapping in
`evaluation/results/raw/blind-judge.jsonl`. It uses the same configured model, so the result is a
**non-independent LLM review**, not a human-reviewed score. Low-confidence, partial, and N/A
decisions are exported to `evaluation/results/review_queue.csv`.

`npm run eval:summary` generates both the canonical `evaluation/results/summary.json` and the
public build copy `public/evaluation/summary.json`; `/benchmark` fetches this generated artifact and
does not contain hand-maintained result numbers.

## Project validation

```bash
npm run tsc
npm run lint
npm test
npm run eval
npm run build
git status --short
```

The final report must list commands actually executed. Missing credentials, skipped commands,
unavailable token telemetry, and failures remain explicit.
