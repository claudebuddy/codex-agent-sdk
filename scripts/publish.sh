#!/usr/bin/env bash
# Release @claudebuddy/codex-agent-sdk to the public npm registry.
#
# Prerequisites (once, by you — no CLI can automate these):
#   1. Create the npm org `claudebuddy` at https://www.npmjs.com/org/claudebuddy
#      (free plan; the npm account you use here must own/create this org).
#   2. Login this machine to the official registry:
#        npm login   # from within this directory (project-level .npmrc points at npmjs.org)
#
# Then just run:  bash scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "registry:  $(npm config get registry)"
echo "whoami:    $(npm whoami)"

# Build the latest dist, then publish as public.
npm run build
npm publish --access public

echo ""
echo "Published: @claudebuddy/codex-agent-sdk@$(node -p "require('./package.json').version")"
echo "View:      https://www.npmjs.com/package/@claudebuddy/codex-agent-sdk"