#!/usr/bin/env bash
# Bugzap — Check, build, and deploy the Cloudflare Worker with Wrangler.
# Don't run directly — use prod.sh or stage.sh, which set DEPLOY_ENV.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; }

format_time() {
  local s=$1
  if [ "$s" -lt 60 ]; then echo "${s}s"; else echo "$((s / 60))m $((s % 60))s"; fi
}

require_cmd() {
  local cmd=$1 hint=${2:-}
  command -v "$cmd" >/dev/null 2>&1 || { log_error "Required command '$cmd' not found. $hint"; exit 1; }
}

DEPLOY_START=$(date +%s)

DRY_RUN=""; FORCE=""
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --force|-f)   FORCE=1 ;;
    --help|-h)
      cat <<USAGE
Usage: $(basename "$0") [--dry-run] [--force]

Runs the type check and tests, builds the widget, and deploys the Worker with Wrangler.

  --dry-run, -n   Check, build, and bundle without deploying.
  --force,   -f   Bypass prod safety gates (does NOT bypass confirmation).

Called via:
  utils/deploy/stage.sh   # deploys bugzap-staging
  utils/deploy/prod.sh    # deploys bugzap (production)

First deploy of an environment: see docs/deploy.md for the one-time setup.
USAGE
      exit 0 ;;
    *) log_error "Unknown flag: $arg"; exit 1 ;;
  esac
done

[ -n "${DEPLOY_ENV:-}" ] || { log_error "DEPLOY_ENV not set — run prod.sh or stage.sh"; exit 1; }
case "$DEPLOY_ENV" in
  prod)  WRANGLER_ENV="production"; WORKER="bugzap";         ENV_LABEL="PRODUCTION"; ENV_COLOR="$RED" ;;
  stage) WRANGLER_ENV="staging";    WORKER="bugzap-staging"; ENV_LABEL="STAGING";    ENV_COLOR="$YELLOW" ;;
  *) log_error "Invalid DEPLOY_ENV: $DEPLOY_ENV"; exit 1 ;;
esac
# v1 runs on workers.dev, whose account subdomain is only known once Wrangler
# reports it. The real URL is read from the deploy output further down.
TARGET_URL="${WORKER} on workers.dev"

require_cmd git  "Git is required."
require_cmd node "Install Node.js 22 or later."
require_cmd npm  "Install Node.js (with npm)."
require_cmd npx  "Install Node.js (with npm) so the local Wrangler can run."

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "$DEPLOY_ENV" = "prod" ] && [ -z "${FORCE:-}" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    log_error "Working tree is dirty. Commit/stash, or pass --force."; exit 1
  fi
  if [ "$GIT_BRANCH" != "main" ]; then
    log_error "Not on 'main' (current: $GIT_BRANCH). Switch or pass --force."; exit 1
  fi
fi

if [ "$DEPLOY_ENV" = "prod" ] && [ -z "${DRY_RUN:-}" ]; then
  echo ""
  echo -e "${RED}${BOLD}⚠  You are about to deploy to PRODUCTION${NC}"
  echo -e "   URL    : ${BOLD}${TARGET_URL}${NC}"
  echo -e "   Commit : ${BOLD}${GIT_SHA}${NC} on ${BOLD}${GIT_BRANCH}${NC}"
  [ -n "${FORCE:-}" ] && echo -e "   Mode   : ${YELLOW}--force (gates bypassed)${NC}"
  read -r -p "Type 'yes' to continue: " CONFIRM
  [ "$CONFIRM" = "yes" ] || { log_error "Aborted."; exit 1; }
fi

export WRANGLER_SEND_METRICS=false
export WRANGLER_LOG_PATH=.wrangler/logs

log_info "Running the type check and tests..."
CHECK_START=$(date +%s)
npm run --silent typecheck
npm test --silent
CHECK_TIME=$(($(date +%s) - CHECK_START))
log_success "Checks passed in $(format_time $CHECK_TIME)"

log_info "Building the widget..."
BUILD_START=$(date +%s)
npm run --silent build:widget
BUILD_TIME=$(($(date +%s) - BUILD_START))
log_success "Widget built in $(format_time $BUILD_TIME)"

# Feral Creative's Cloudflare account; `d1 migrations list` ignores the env's account_id when several accounts are signed in.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-30aa05fc7822ef63635046e5c7771a9a}"

# One-time setup guard: the environment's database must exist and be named in wrangler.jsonc.
SETUP_DONE=1
if grep -A3 "\"database_name\": \"bugzap-${WRANGLER_ENV}\"" wrangler.jsonc | grep -q '00000000-0000-0000-0000-000000000000'; then
  SETUP_DONE=""
  if [ -n "${DRY_RUN:-}" ]; then
    log_warning "wrangler.jsonc has no database id for ${WRANGLER_ENV} yet; a real deploy would stop here. See docs/deploy.md."
  else
    log_error "wrangler.jsonc has no database id for ${WRANGLER_ENV} yet. Do the one-time setup in docs/deploy.md first."
    exit 1
  fi
fi

# The Worker queries every table in migrations/, so shipping code ahead of its schema breaks sign-in and ingest for everyone.
if [ -n "$SETUP_DONE" ]; then
  log_info "Checking ${WRANGLER_ENV} D1 for unapplied migrations..."
  if ! MIGRATIONS=$(npx wrangler d1 migrations list DB --env "$WRANGLER_ENV" --remote 2>&1); then
    echo "$MIGRATIONS" >&2
    if [ -n "${DRY_RUN:-}" ]; then
      log_warning "Could not read the ${WRANGLER_ENV} D1 migration state; a real deploy would stop here."
    else
      log_error "Could not read the ${WRANGLER_ENV} D1 migration state."; exit 1
    fi
  elif ! echo "$MIGRATIONS" | grep -q "No migrations to apply"; then
    echo "$MIGRATIONS" | sed -n '/Migrations to be applied/,$p'
    if [ -n "${DRY_RUN:-}" ]; then
      log_warning "${WRANGLER_ENV} D1 has unapplied migrations; a real deploy would stop here."
    else
      log_error "${WRANGLER_ENV} D1 has unapplied migrations. Apply them first, then deploy again:"
      echo "  CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID} npx wrangler d1 migrations apply DB --env ${WRANGLER_ENV} --remote" >&2
      exit 1
    fi
  else
    log_success "${WRANGLER_ENV} D1 schema is current"
  fi
fi

DEPLOY_PHASE_START=$(date +%s)
if [ -n "${DRY_RUN:-}" ]; then
  log_info "Bundling Worker for ${WRANGLER_ENV} (dry run)..."
  npx wrangler deploy --env "$WRANGLER_ENV" --dry-run --outdir .wrangler/dry-run
else
  log_info "Deploying Worker to ${WRANGLER_ENV}..."
  DEPLOY_LOG=$(mktemp -t bugzap-deploy.XXXXXX)
  trap 'rm -f "$DEPLOY_LOG"' EXIT
  npx wrangler deploy --env "$WRANGLER_ENV" 2>&1 | tee "$DEPLOY_LOG"
  DEPLOYED_URL=$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -1 || true)
  [ -n "$DEPLOYED_URL" ] && TARGET_URL="$DEPLOYED_URL"
fi
DEPLOY_TIME=$(($(date +%s) - DEPLOY_PHASE_START))

TOTAL_TIME=$(($(date +%s) - DEPLOY_START))

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}                   ${GREEN}DEPLOYMENT SUMMARY${NC}                          ${CYAN}║${NC}"
echo -e "${CYAN}╠════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}   Environment  : ${ENV_COLOR}${BOLD}${ENV_LABEL}${NC}"
echo -e "${CYAN}║${NC}   Target       : ${BOLD}${TARGET_URL}${NC}"
echo -e "${CYAN}║${NC}   Git          : ${BOLD}${GIT_SHA}${NC} (${GIT_BRANCH})"
echo -e "${CYAN}║${NC}   Check time   : ${BLUE}$(format_time $CHECK_TIME)${NC}"
echo -e "${CYAN}║${NC}   Build time   : ${BLUE}$(format_time $BUILD_TIME)${NC}"
echo -e "${CYAN}║${NC}   Deploy time  : ${BLUE}$(format_time $DEPLOY_TIME)${NC}"
echo -e "${CYAN}║${NC}   Total time   : ${GREEN}$(format_time $TOTAL_TIME)${NC}"
[ -n "${DRY_RUN:-}" ] && echo -e "${CYAN}║${NC}   Mode         : ${YELLOW}dry run (nothing deployed)${NC}"
echo -e "${CYAN}║${NC}   Timestamp    : $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"

if [ -z "${DRY_RUN:-}" ]; then
  echo ""
  echo -e "${YELLOW}Useful commands:${NC}"
  echo "  Tail logs (sign-in links print here):  npx wrangler tail ${WORKER}"
  echo ""
fi
