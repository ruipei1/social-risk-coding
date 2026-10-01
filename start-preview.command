#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bundled_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$bundled_node" ]; then
  coding_node="$bundled_node"
else
  coding_node="$(command -v node)"
fi
"$coding_node" -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Please use Node.js 24.")'
if [ -f "../Combined data/social_risk_combined_analysis.csv" ]; then
  "$coding_node" manage.mjs import
fi
exec "$coding_node" server.mjs --preview
