#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.config/releaseguard/live-eval.env"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then source "$HOME/.nvm/nvm.sh"; nvm use --silent 22 >/dev/null; fi
npm run eval:judge:v7 > /tmp/releaseguard-blind-judge-v7.stdout 2> /tmp/releaseguard-blind-judge-v7.stderr
touch /tmp/releaseguard-blind-judge-v7.done
