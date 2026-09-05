#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."
source "$HOME/.config/releaseguard/live-eval.env"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22 >/dev/null
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "WSL_NODE_RUNTIME_REQUIRED" >&2
  exit 1
fi

output_root="evaluation/results/v2"
mkdir -p "$output_root/raw" "$output_root/checkpoints"
export LIVE_EVAL_TRANSPORT_RETRIES=2
export LIVE_EVAL_RETRY_BASE_DELAY_MS=500
export LIVE_EVAL_FIXTURE_QUERY_HINTS=true
export LIVE_EVAL_STOP_ON_QUOTA=true

for run_index in 1 2 3; do
  archive="$output_root/raw/harness-v2-run-${run_index}.json"
  checkpoint_dir="$output_root/checkpoints/run-${run_index}"
  mkdir -p "$checkpoint_dir"
  if [[ -f "$archive" ]] && node -e '
    const report = require("./" + process.argv[1]);
    if (report.reportStatus !== "COMPLETE" || report.cases?.length !== 22) process.exit(1);
  ' "$archive"; then
    continue
  fi
  existing_final="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.partial.json' -print -quit)"
  if [[ -n "$existing_final" ]]; then
    cp "$existing_final" "$archive"
    continue
  fi
  partial="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.partial.json' -print -quit)"
  export LIVE_EVAL_REPORT_DIR="$checkpoint_dir"
  export LIVE_EVAL_RUN_ID="HARNESS-V2-RUN-${run_index}"
  if [[ -n "$partial" ]]; then export LIVE_EVAL_RESUME_PARTIAL="$partial";
  else unset LIVE_EVAL_RESUME_PARTIAL;
  fi
  npm run eval:investigation-live -- --provider=live \
    >"/tmp/releaseguard-harness-v2-run${run_index}.stdout" \
    2>"/tmp/releaseguard-harness-v2-run${run_index}.stderr" || true
  if grep -q "PROVIDER_QUOTA_EXHAUSTED" "/tmp/releaseguard-harness-v2-run${run_index}.stderr"; then
    exit 42
  fi
  final="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.partial.json' -print -quit)"
  if [[ -n "$final" ]]; then cp "$final" "$archive"; fi
done

touch /tmp/releaseguard-harness-v2-series.done
