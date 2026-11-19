#!/usr/bin/env bash
# Bugzap — Staging deploy wrapper.
# Pass --dry-run to bundle without deploying.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEPLOY_ENV="stage"
exec "$SCRIPT_DIR/deploy.sh" "$@"
