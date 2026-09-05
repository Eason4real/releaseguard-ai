#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."; source "$HOME/.config/releaseguard/live-eval.env"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then source "$HOME/.nvm/nvm.sh"; nvm use --silent 22 >/dev/null; fi
root="evaluation/results/v6"; mkdir -p "$root/raw" "$root/checkpoints"
identity="$({ find app lib eval scripts tests evaluation/config -type f ! -path '*/results/*' ! -path '*/.sites-runtime/*' -print0; printf '%s\0' package.json package-lock.json; } | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; printf '%s\n' "$identity" > "$root/source-content.sha256"
export LIVE_EVAL_TRANSPORT_RETRIES=2 LIVE_EVAL_RETRY_BASE_DELAY_MS=500 LIVE_EVAL_FIXTURE_QUERY_HINTS=true LIVE_EVAL_HARNESS_VERSION=V6 LIVE_EVAL_SOURCE_IDENTITY="sha256:$identity" LIVE_EVAL_STOP_ON_QUOTA=true
for i in 1 2 3; do
  archive="$root/raw/harness-v6-run-$i.json"; dir="$root/checkpoints/run-$i"; mkdir -p "$dir"
  if [[ -f "$archive" ]] && node -e 'const r=require("./"+process.argv[1]),c=r.manifest?.modelConfiguration;if(r.reportStatus!=="COMPLETE"||r.cases?.length!==22||c?.harnessVersion!=="V6"||c?.sourceIdentity!==process.env.LIVE_EVAL_SOURCE_IDENTITY)process.exit(1)' "$archive"; then continue; fi
  partial="$(find "$dir" -maxdepth 1 -name '*.partial.json' -type f -print -quit)"; export LIVE_EVAL_REPORT_DIR="$dir" LIVE_EVAL_RUN_ID="HARNESS-V6-RUN-$i"; if [[ -n "$partial" ]]; then export LIVE_EVAL_RESUME_PARTIAL="$partial"; else unset LIVE_EVAL_RESUME_PARTIAL; fi
  npm run eval:investigation-live -- --provider=live >"/tmp/releaseguard-harness-v6-run$i.stdout" 2>"/tmp/releaseguard-harness-v6-run$i.stderr" || true
  if grep -q 'PROVIDER_QUOTA_EXHAUSTED' "/tmp/releaseguard-harness-v6-run$i.stderr"; then exit 42; fi
  final="$(find "$dir" -maxdepth 1 -name '*.json' ! -name '*.partial.json' -type f -print -quit)"; [[ -n "$final" ]] || exit 3; cp "$final" "$archive"
done
touch /tmp/releaseguard-harness-v6-series.done
