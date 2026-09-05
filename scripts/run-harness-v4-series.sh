#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
source "$HOME/.config/releaseguard/live-eval.env"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then source "$HOME/.nvm/nvm.sh"; nvm use --silent 22 >/dev/null; fi
output_root="evaluation/results/v4"
mkdir -p "$output_root/raw" "$output_root/checkpoints"
source_identity="$({ find app lib eval scripts tests evaluation/config -type f ! -path '*/results/*' ! -path '*/.sites-runtime/*' -print0; printf '%s\0' package.json package-lock.json; } | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
printf '%s\n' "$source_identity" > "$output_root/source-content.sha256"
export LIVE_EVAL_TRANSPORT_RETRIES=2 LIVE_EVAL_RETRY_BASE_DELAY_MS=500 LIVE_EVAL_FIXTURE_QUERY_HINTS=true LIVE_EVAL_HARNESS_VERSION=V4 LIVE_EVAL_SOURCE_IDENTITY="sha256:$source_identity" LIVE_EVAL_STOP_ON_QUOTA=true
for run_index in 1 2 3; do
  archive="$output_root/raw/harness-v4-run-${run_index}.json"; checkpoint_dir="$output_root/checkpoints/run-${run_index}"; mkdir -p "$checkpoint_dir"
  if [[ -f "$archive" ]] && node -e 'const r=require("./"+process.argv[1]); const c=r.manifest?.modelConfiguration; if(r.reportStatus!=="COMPLETE"||r.cases?.length!==22||c?.harnessVersion!=="V4"||c?.sourceIdentity!==process.env.LIVE_EVAL_SOURCE_IDENTITY)process.exit(1)' "$archive"; then continue; fi
  final="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.partial.json' -print -quit)"
  if [[ -n "$final" ]]; then cp "$final" "$archive"; continue; fi
  partial="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.partial.json' -print -quit)"; export LIVE_EVAL_REPORT_DIR="$checkpoint_dir" LIVE_EVAL_RUN_ID="HARNESS-V4-RUN-${run_index}"
  if [[ -n "$partial" ]]; then export LIVE_EVAL_RESUME_PARTIAL="$partial"; else unset LIVE_EVAL_RESUME_PARTIAL; fi
  npm run eval:investigation-live -- --provider=live >"/tmp/releaseguard-harness-v4-run${run_index}.stdout" 2>"/tmp/releaseguard-harness-v4-run${run_index}.stderr" || true
  if grep -q "PROVIDER_QUOTA_EXHAUSTED" "/tmp/releaseguard-harness-v4-run${run_index}.stderr"; then exit 42; fi
  final="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.partial.json' -print -quit)"; if [[ -n "$final" ]]; then cp "$final" "$archive"; fi
done
touch /tmp/releaseguard-harness-v4-series.done
