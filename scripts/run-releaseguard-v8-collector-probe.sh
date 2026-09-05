#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
source "$HOME/.config/releaseguard/live-eval.env"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then source "$HOME/.nvm/nvm.sh"; nvm use --silent 22 >/dev/null; fi

root="evaluation/results/v8/collector-probe-v3"
mkdir -p "$root/checkpoints"
identity="$({ find app lib eval scripts tests evaluation/config -type f ! -path '*/results/*' ! -path '*/.sites-runtime/*' -print0; printf '%s\0' package.json package-lock.json; } | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
printf '%s\n' "$identity" > "$root/source-content.sha256"
export LIVE_EVAL_TRANSPORT_RETRIES=2 LIVE_EVAL_RETRY_BASE_DELAY_MS=500
export LIVE_EVAL_FIXTURE_QUERY_HINTS=false LIVE_EVAL_HARNESS_VERSION=V8
export LIVE_EVAL_SOURCE_IDENTITY="sha256:$identity" LIVE_EVAL_STOP_ON_QUOTA=true
export LIVE_EVAL_CASE_IDS="CASE-204,CASE-206,CASE-213,CASE-218,CASE-221"
export LIVE_EVAL_REPORT_DIR="$root/checkpoints" LIVE_EVAL_RUN_ID="HARNESS-V8-COLLECTOR-PROBE-V3"

partial="$(find "$root/checkpoints" -maxdepth 1 -name '*.partial.json' -type f -print -quit)"
if [[ -n "$partial" ]] && node -e 'const r=require("./"+process.argv[1]); const c=r.manifest?.modelConfiguration; if(r.reportStatus!=="INCOMPLETE"||JSON.stringify(r.manifest?.caseSelection)!==JSON.stringify(process.env.LIVE_EVAL_CASE_IDS.split(","))||c?.harnessVersion!=="V8"||c?.sourceIdentity!==process.env.LIVE_EVAL_SOURCE_IDENTITY) process.exit(1)' "$partial"; then
  export LIVE_EVAL_RESUME_PARTIAL="$partial"
fi
npm run eval:investigation-live -- --provider=live >"/tmp/releaseguard-harness-v8-collector-probe.stdout" 2>"/tmp/releaseguard-harness-v8-collector-probe.stderr" || true
if grep -q 'PROVIDER_QUOTA_EXHAUSTED' "/tmp/releaseguard-harness-v8-collector-probe.stderr"; then exit 42; fi
final="$(find "$root/checkpoints" -maxdepth 1 -name '*.json' ! -name '*.partial.json' -type f -print -quit)"
[[ -n "$final" ]] || exit 3
cp "$final" "$root/collector-probe-v3.json"
touch /tmp/releaseguard-harness-v8-collector-probe-v3.done
