#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."
source "$HOME/.config/releaseguard/live-eval.env"

current_pid="${1:-}"
if [[ -n "$current_pid" ]]; then
  while kill -0 "$current_pid" 2>/dev/null; do sleep 30; done
  latest="$(find reports/investigation-benchmark -maxdepth 1 -type f -name '*.json' ! -name '*.partial.json' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
  if [[ -n "$latest" ]]; then cp "$latest" evaluation/results/raw/improved-agent-run-1.json; fi
fi

for run_index in 2 3; do
  stdout="/tmp/releaseguard-improved-agent-run${run_index}.stdout"
  stderr="/tmp/releaseguard-improved-agent-run${run_index}.stderr"
  npm run eval:investigation-live -- --provider=live >"$stdout" 2>"$stderr" || true
  latest="$(find reports/investigation-benchmark -maxdepth 1 -type f -name '*.json' ! -name '*.partial.json' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
  if [[ -n "$latest" ]]; then cp "$latest" "evaluation/results/raw/improved-agent-run-${run_index}.json"; fi
done

touch /tmp/releaseguard-improved-agent-series.done
