#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."
while [[ ! -f /tmp/releaseguard-improved-agent-series.done ]]; do sleep 30; done
source "$HOME/.config/releaseguard/live-eval.env"
if ! npm run eval:judge > /tmp/releaseguard-blind-judge.stdout 2> /tmp/releaseguard-blind-judge.stderr; then
  touch /tmp/releaseguard-evaluation-finalized.failed
  exit 1
fi
if ! npm run eval:summary > /tmp/releaseguard-summary.stdout 2> /tmp/releaseguard-summary.stderr; then
  touch /tmp/releaseguard-evaluation-finalized.failed
  exit 1
fi
if ! npm run eval:report > /tmp/releaseguard-report.stdout 2> /tmp/releaseguard-report.stderr; then
  touch /tmp/releaseguard-evaluation-finalized.failed
  exit 1
fi
touch /tmp/releaseguard-evaluation-finalized.done
