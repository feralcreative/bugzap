#!/usr/bin/env bash
# Bugzap — Production deploy wrapper.
# Pass --dry-run to bundle without deploying, --force to bypass the clean-tree / on-main gates.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DEPLOY_ENV="prod"
exec "$SCRIPT_DIR/deploy.sh" "$@"
