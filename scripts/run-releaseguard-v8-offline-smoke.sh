#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.config/releaseguard/live-eval.env"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent 22 >/dev/null
fi

root="evaluation/results/v8/smoke"
mkdir -p "$root/raw"
export V8_SMOKE_SERIES="contract-v2"
source_identity="$({ sha256sum lib/investigation/evidence-packet-v2.ts lib/investigation/llm-synthesizer.ts lib/investigation/llm-planner.ts lib/investigation/planner-decision-semantics.ts scripts/run-releaseguard-v8-offline-smoke.mjs evaluation/results/v8/smoke/input/agent-input.json; } | sha256sum | awk '{print $1}')"
identity_path="$root/$V8_SMOKE_SERIES.source.sha256"
if [[ -f "$identity_path" ]] && [[ "$(tr -d '\r\n' < "$identity_path")" != "$source_identity" ]]; then
  echo "V8_SMOKE_SOURCE_IDENTITY_MISMATCH" >&2
  exit 4
fi
if [[ ! -f "$identity_path" ]]; then printf '%s\n' "$source_identity" > "$identity_path"; fi
npm run eval:smoke:validate:v8
npm run eval:smoke:v8 >"/tmp/releaseguard-harness-v8-smoke.stdout" \
  2>"/tmp/releaseguard-harness-v8-smoke.stderr" || true

if grep -Eq 'PROVIDER_QUOTA_EXHAUSTED|(^|[^0-9])402([^0-9]|$)|Insufficient Balance' \
  "/tmp/releaseguard-harness-v8-smoke.stderr"; then
  exit 42
fi

node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const rows = (await readFile(`evaluation/results/v8/smoke/raw/synthesis-attempts-${process.env.V8_SMOKE_SERIES}.jsonl`, "utf8"))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const effective = new Map();
  for (const row of rows) if (!effective.has(row.sampleId) || !row.error) effective.set(row.sampleId, row);
  const records = [...effective.values()];
  if (records.length !== 17 || records.some((row) => row.error) || records.some((row) => row.toolCalls !== 0)) {
    process.exit(3);
  }
'
npm run eval:smoke:score:v8
touch /tmp/releaseguard-harness-v8-smoke.done
