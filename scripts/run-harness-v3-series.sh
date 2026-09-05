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

output_root="evaluation/results/v3"
mkdir -p "$output_root/raw" "$output_root/checkpoints"

source_identity="$({
  find app lib eval scripts tests evaluation/config -type f \
    ! -path '*/results/*' ! -path '*/.sites-runtime/*' -print0
  printf '%s\0' package.json package-lock.json
} | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
printf '%s\n' "$source_identity" > "$output_root/source-content.sha256"

export LIVE_EVAL_TRANSPORT_RETRIES=2
export LIVE_EVAL_RETRY_BASE_DELAY_MS=500
export LIVE_EVAL_FIXTURE_QUERY_HINTS=true
export LIVE_EVAL_HARNESS_VERSION=V3
export LIVE_EVAL_SOURCE_IDENTITY="sha256:$source_identity"
export LIVE_EVAL_STOP_ON_QUOTA=true

for run_index in 1 2 3; do
  archive="$output_root/raw/harness-v3-run-${run_index}.json"
  checkpoint_dir="$output_root/checkpoints/run-${run_index}"
  mkdir -p "$checkpoint_dir"
  if [[ -f "$archive" ]] && node -e '
    const report = require("./" + process.argv[1]);
    const config = report.manifest?.modelConfiguration;
    if (report.reportStatus !== "COMPLETE" || report.cases?.length !== 22
      || config?.harnessVersion !== "V3"
      || config?.sourceIdentity !== process.env.LIVE_EVAL_SOURCE_IDENTITY) process.exit(1);
  ' "$archive"; then
    continue
  fi
  existing_final="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.json' \
    ! -name '*.partial.json' -print -quit)"
  if [[ -n "$existing_final" ]]; then
    if node -e '
      const report = require("./" + process.argv[1]);
      const config = report.manifest?.modelConfiguration;
      if (report.reportStatus !== "COMPLETE" || report.cases?.length !== 22
        || config?.harnessVersion !== "V3"
        || config?.sourceIdentity !== process.env.LIVE_EVAL_SOURCE_IDENTITY) process.exit(1);
    ' "$existing_final"; then
      cp "$existing_final" "$archive"
      continue
    fi
    echo "V3_INCOMPATIBLE_FINAL_CHECKPOINT run=$run_index" >&2
    exit 3
  fi
  partial="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.partial.json' -print -quit)"
  export LIVE_EVAL_REPORT_DIR="$checkpoint_dir"
  export LIVE_EVAL_RUN_ID="HARNESS-V3-RUN-${run_index}"
  if [[ -n "$partial" ]]; then export LIVE_EVAL_RESUME_PARTIAL="$partial";
  else unset LIVE_EVAL_RESUME_PARTIAL;
  fi
  npm run eval:investigation-live -- --provider=live \
    >"/tmp/releaseguard-harness-v3-run${run_index}.stdout" \
    2>"/tmp/releaseguard-harness-v3-run${run_index}.stderr" || true
  if grep -q "PROVIDER_QUOTA_EXHAUSTED" "/tmp/releaseguard-harness-v3-run${run_index}.stderr"; then
    exit 42
  fi
  final="$(find "$checkpoint_dir" -maxdepth 1 -type f -name '*.json' \
    ! -name '*.partial.json' -print -quit)"
  if [[ -n "$final" ]]; then cp "$final" "$archive"; fi
done

touch /tmp/releaseguard-harness-v3-series.done
