#!/usr/bin/env bash
set -euo pipefail

# chant#2403 — the scale-estate harness (chant-bench#33's chant-side arm).
#
# Builds and deploys a generated multi-stack chant project
# (scripts/generate-scale-estate.ts) against floci, one `chant run` per
# stack — no single-invocation driver deploys N stacks as one estate today
# (see that script's own header) — then reads the whole estate back with one
# `chant lifecycle plan local`, which discovers every stack's own
# *.component.ts and observes each (see
# packages/core/src/cli/handlers/lifecycle.ts's componentStacks). Emits a
# choudoufu-shaped cost record (schema/estate/target/scale/commit/resources/
# stages/plan_calls) so chant-bench's ingest reads it without a second
# parser.
#
# This is NOT a comparison with choudoufu: two independent results, each
# proving its own tool handles the size on its own path.
#
# Streams as it goes — a long run should never look stuck:
#   - a line per stack as it starts and finishes (index, name, resource
#     count, verdict, seconds), not buffered to the end
#   - a running total after every stack (stacks done, resources applied,
#     elapsed)
#   - a heartbeat every few seconds while a stack is mid-apply, from
#     `DescribeStackEvents` (how many of its resources have reached
#     *_COMPLETE so far) — the same signal `waitForStackSettled` in
#     lexicons/aws/src/op/activities/aws-apply.ts already polls via
#     DescribeStacks, read here independently so the harness's own progress
#     line doesn't depend on chant's internal polling interval
#   - a failure prints immediately — which stack, which resource (from the
#     first *_FAILED stack event), the reason — and says whether the run is
#     stopping or continuing
#
# Resumable: re-running this script against the SAME floci container skips
# every stack `DescribeStacks` already reports CREATE_COMPLETE/
# UPDATE_COMPLETE, and skips re-generating the project if its manifest
# already exists. A run that dies at stack 14 of 20 picks up at 14 on the
# next invocation, not 1 — as long as the container from the first attempt
# is still up (a failed/interrupted run leaves it running on purpose; only
# a clean full pass tears it down, unless --keep is given).
#
# Usage:
#   test/scale-estate.sh down [container-name]
#     Tear down a left-running floci container and exit.
#
#   test/scale-estate.sh --out <dir> (--stacks <n> | --resources <r>)
#       [--teams-per-stack <k>] [--port <p>] [--record <path>]
#       [--continue-on-failure] [--keep] [--force]
#
#     --port                 floci's host port (default 4691) — container is
#                             always named chant-scale-floci.
#     --record <path>        where to write the cost record (default:
#                             <out>/../scale-record.json).
#     --continue-on-failure  keep deploying remaining stacks after one fails,
#                             instead of stopping immediately (default: stop).
#     --keep                 never tear down floci at the end, even on a
#                             clean pass (default: tear down only on a clean
#                             pass; a failed/stopped run always leaves it up).
#     --force                regenerate the project even if a manifest
#                             already exists at --out.
#
# Needs: docker, the aws CLI, jq, node, npx. Never talks to real AWS — every
# AWS_ENDPOINT_URL this script sets points at floci or at its own counting
# proxy in front of floci.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOCI_IMAGE_FILE="${FLOCI_IMAGE_FILE:-/Users/alex/Documents/checkouts/intentius/choudoufu/live/floci-image}"
CONTAINER="chant-scale-floci"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ---- `down` subcommand: tear down and exit, nothing else ------------------
if [ "${1:-}" = "down" ]; then
  NAME="${2:-$CONTAINER}"
  if docker rm -f "$NAME" >/dev/null 2>&1; then
    log "torn down $NAME"
  else
    log "no running container named $NAME"
  fi
  exit 0
fi

# ---- args -------------------------------------------------------------
OUT=""
STACKS=""
RESOURCES=""
TEAMS_PER_STACK=""
PORT=4691
RECORD_PATH=""
CONTINUE_ON_FAILURE=0
KEEP=0
FORCE_REGENERATE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --stacks) STACKS="$2"; shift 2 ;;
    --resources) RESOURCES="$2"; shift 2 ;;
    --teams-per-stack) TEAMS_PER_STACK="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --record) RECORD_PATH="$2"; shift 2 ;;
    --continue-on-failure) CONTINUE_ON_FAILURE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --force) FORCE_REGENERATE=1; shift ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "scale-estate.sh: unknown argument \"$1\"" >&2; exit 1 ;;
  esac
done

[ -n "$OUT" ] || { echo "scale-estate.sh: --out <dir> is required" >&2; exit 1; }
if [ -z "$STACKS" ] && [ -z "$RESOURCES" ]; then
  echo "scale-estate.sh: one of --stacks or --resources is required" >&2
  exit 1
fi
OUT="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
RECORD_PATH="${RECORD_PATH:-$OUT/../scale-record.json}"

ENDPOINT="http://localhost:${PORT}"
PROXY_PORT=$((PORT + 1))
PROXY_ENDPOINT="http://localhost:${PROXY_PORT}"

command -v docker >/dev/null 2>&1 || { echo "scale-estate.sh: docker is required" >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "scale-estate.sh: the aws CLI is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "scale-estate.sh: jq is required" >&2; exit 1; }

# ---- 1. floci up, idempotent -------------------------------------------
log "=== floci on :$PORT (container $CONTAINER) ==="
IMAGE="$(cat "$FLOCI_IMAGE_FILE")"

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "floci already running as $CONTAINER — reusing (resumable)"
else
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --rm -p "${PORT}:4566" --name "$CONTAINER" "$IMAGE" >/dev/null
  log "started $CONTAINER from $IMAGE"
fi

i=0
until curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation":"running"'; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    log "FAIL [floci]: did not become healthy within 120s"
    docker logs "$CONTAINER" 2>&1 | tail -50
    exit 1
  fi
  sleep 2
done
log "floci healthy after $((i * 2))s"

export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
export AWS_ENDPOINT_URL="$ENDPOINT"

# ---- 2. generate the project, idempotent -------------------------------
log "=== generate estate at $OUT ==="
GEN_ARGS=(--out "$OUT")
[ -n "$STACKS" ] && GEN_ARGS+=(--stacks "$STACKS")
[ -n "$RESOURCES" ] && GEN_ARGS+=(--resources "$RESOURCES")
[ -n "$TEAMS_PER_STACK" ] && GEN_ARGS+=(--teams-per-stack "$TEAMS_PER_STACK")

if [ -f "$OUT/estate-manifest.json" ] && [ "$FORCE_REGENERATE" -eq 0 ]; then
  log "estate-manifest.json already exists — reusing (resumable; pass --force to regenerate)"
else
  npx --prefix "$ROOT" tsx "$ROOT/scripts/generate-scale-estate.ts" "${GEN_ARGS[@]}"
fi

MANIFEST="$OUT/estate-manifest.json"
[ -f "$MANIFEST" ] || { log "FAIL [generate]: no manifest at $MANIFEST"; exit 1; }

STACK_COUNT="$(jq -r '.stacks' "$MANIFEST")"
PER_STACK="$(jq -r '.perStackResources' "$MANIFEST")"
TOTAL_RESOURCES="$(jq -r '.totalResources' "$MANIFEST")"
FORMULA="$(jq -r '.formula' "$MANIFEST")"
STACK_NAMES=()
while IFS= read -r line; do STACK_NAMES+=("$line"); done < <(jq -r '.stackNames[]' "$MANIFEST")

log "formula: $FORMULA"
log "stacks=$STACK_COUNT perStack=$PER_STACK total=$TOTAL_RESOURCES"
echo "VERDICT stage=generate verdict=pass seconds=0 detail=\"stacks=$STACK_COUNT perStack=$PER_STACK resources=$TOTAL_RESOURCES\""

# node_modules for the generated project — it lives outside the monorepo, so
# `npx`/`chant` cannot walk up to this checkout's own workspace packages
# (same fix test/aws-cc-e2e.sh uses).
mkdir -p "$OUT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$OUT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/aws" "$OUT/node_modules/@intentius/chant-lexicon-aws"
export PATH="$ROOT/node_modules/.bin:$PATH"
CHANT="$ROOT/packages/core/bin/chant"
cd "$OUT"

# ---- helpers ------------------------------------------------------------

resource_count_of() { # $1 = stack name
  jq '.Resources | length' "$OUT/src/$1/template.json" 2>/dev/null || echo 0
}

stack_status() { # $1 = stack name; "NONE" if it doesn't exist / can't be read
  aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NONE"
}

# Distinct logical ids (excluding the stack resource itself) that have
# reached a *_COMPLETE status so far — the heartbeat's own progress number.
count_landed_resources() { # $1 = stack name
  aws cloudformation describe-stack-events --stack-name "$1" 2>/dev/null \
    | jq '[.StackEvents[] | select(.ResourceStatus | test("_COMPLETE$")) | select(.ResourceType != "AWS::CloudFormation::Stack") | .LogicalResourceId] | unique | length' \
    2>/dev/null || echo 0
}

# The first (earliest) *_FAILED stack event, as "logicalId (type): reason".
first_failure_of() { # $1 = stack name
  aws cloudformation describe-stack-events --stack-name "$1" 2>/dev/null \
    | jq -r '[.StackEvents[] | select(.ResourceStatus | test("_FAILED$"))] | sort_by(.Timestamp) | .[0] | select(. != null) | "\(.LogicalResourceId) (\(.ResourceType)): \(.ResourceStatusReason // "no reason given")"' \
    2>/dev/null || true
}

# Deploys (or, if already live, confirms) one stack, streaming progress.
# Returns 0 on a verified CREATE_COMPLETE/already-complete, 1 otherwise —
# updates the global DONE/RESOURCES_APPLIED counters on success.
deploy_one_stack() {
  local STACK="$1" IDX="$2"
  local BUILD_LOG RES_COUNT EXISTING STACK_START DEPLOY_LOG DEPLOY_PID LANDED HB_ELAPSED RC FINAL_STATUS STACK_SECONDS DETAIL

  BUILD_LOG="$(mktemp)"
  if ! "$CHANT" build "src/$STACK" --lexicon aws -o "src/$STACK/template.json" >"$BUILD_LOG" 2>&1; then
    log "FAIL [$STACK/build]: $(tail -5 "$BUILD_LOG" | tr '\n' ' ')"
    return 1
  fi
  RES_COUNT="$(resource_count_of "$STACK")"

  EXISTING="$(stack_status "$STACK")"
  if [ "$EXISTING" = "CREATE_COMPLETE" ] || [ "$EXISTING" = "UPDATE_COMPLETE" ]; then
    log "stack $IDX/$STACK_COUNT: $STACK already $EXISTING ($RES_COUNT resources) — skipping (resumed)"
    DONE=$((DONE + 1))
    RESOURCES_APPLIED=$((RESOURCES_APPLIED + RES_COUNT))
    return 0
  fi

  log "stack $IDX/$STACK_COUNT: $STACK starting deploy ($RES_COUNT resources)"
  STACK_START=$(date +%s)
  DEPLOY_LOG="$(mktemp)"
  "$CHANT" run --components "$STACK" --env local --no-release-record >"$DEPLOY_LOG" 2>&1 &
  DEPLOY_PID=$!

  # Heartbeat: poll the stack's own events while chant's apply is in flight —
  # never a blind, silent wait on the child process.
  while kill -0 "$DEPLOY_PID" 2>/dev/null; do
    sleep 3
    LANDED="$(count_landed_resources "$STACK")"
    HB_ELAPSED=$(($(date +%s) - STACK_START))
    log "  ... $STACK: ${LANDED:-0}/$RES_COUNT resources landed (${HB_ELAPSED}s)"
  done

  RC=0
  wait "$DEPLOY_PID" || RC=$?
  STACK_SECONDS=$(($(date +%s) - STACK_START))

  if [ "$RC" -ne 0 ]; then
    DETAIL="$(first_failure_of "$STACK")"
    log "FAIL [$STACK]: chant run --components $STACK exited $RC after ${STACK_SECONDS}s"
    if [ -n "$DETAIL" ]; then
      log "  first failure: $DETAIL"
    else
      tail -10 "$DEPLOY_LOG" | while IFS= read -r line; do log "  $line"; done
    fi
    return 1
  fi

  FINAL_STATUS="$(stack_status "$STACK")"
  if [ "$FINAL_STATUS" != "CREATE_COMPLETE" ]; then
    DETAIL="$(first_failure_of "$STACK")"
    log "FAIL [$STACK]: chant run exited 0 but stack status is $FINAL_STATUS, expected CREATE_COMPLETE"
    [ -n "$DETAIL" ] && log "  first failure: $DETAIL"
    return 1
  fi

  DONE=$((DONE + 1))
  RESOURCES_APPLIED=$((RESOURCES_APPLIED + RES_COUNT))
  log "stack $IDX/$STACK_COUNT: $STACK done $FINAL_STATUS ($RES_COUNT resources) in ${STACK_SECONDS}s"
  return 0
}

# ---- 3. deploy every stack ----------------------------------------------
log "=== deploy: one chant run per stack ==="
DEPLOY_START=$(date +%s)
DONE=0
RESOURCES_APPLIED=0
STOPPED=0

i=0
for STACK in "${STACK_NAMES[@]}"; do
  i=$((i + 1))
  if ! deploy_one_stack "$STACK" "$i"; then
    STOPPED=1
    if [ "$CONTINUE_ON_FAILURE" -eq 0 ]; then
      log "  stopping (pass --continue-on-failure to keep going)"
      break
    fi
    log "  continuing to remaining stacks (--continue-on-failure)"
  fi
  ELAPSED=$(($(date +%s) - DEPLOY_START))
  log "  totals: $DONE/$STACK_COUNT stacks, $RESOURCES_APPLIED/$TOTAL_RESOURCES resources, ${ELAPSED}s elapsed"
done
DEPLOY_SECONDS=$(($(date +%s) - DEPLOY_START))

DEPLOY_VERDICT="pass"
[ "$DONE" -eq "$STACK_COUNT" ] || DEPLOY_VERDICT="fail"
echo "VERDICT stage=cold_deploy verdict=$DEPLOY_VERDICT seconds=$DEPLOY_SECONDS detail=\"$DONE/$STACK_COUNT stacks, $RESOURCES_APPLIED/$TOTAL_RESOURCES resources\""

if [ "$DEPLOY_VERDICT" = "fail" ] && [ "$CONTINUE_ON_FAILURE" -eq 0 ]; then
  log "=== stopped early: $DONE/$STACK_COUNT stacks deployed ==="
  log "floci left running as $CONTAINER for investigation — rerun this exact command to resume, or \`test/scale-estate.sh down\` to tear down"
  echo "VERDICT stage=test_plan verdict=not_run seconds=0 detail=\"skipped: cold_deploy did not complete\""
  echo "VERDICT overall=fail"
  exit 1
fi

# ---- 4. read the estate back, cost measured via a counting proxy -------
log "=== read-back: chant lifecycle plan local ==="
node "$ROOT/scripts/api-call-proxy.mjs" >"$OUT/.api-call-proxy.log" 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
i=0
until curl -fs "${PROXY_ENDPOINT}/__counts" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 20 ] && { log "FAIL [proxy]: api-call-proxy.mjs did not come up"; cat "$OUT/.api-call-proxy.log"; exit 1; }
  sleep 0.5
done
curl -fs -X POST "${PROXY_ENDPOINT}/__reset" >/dev/null

PLAN_START=$(date +%s)
PLAN_LOG="$(mktemp)"
PLAN_EXIT=0
AWS_ENDPOINT_URL="$PROXY_ENDPOINT" "$CHANT" lifecycle plan local >"$PLAN_LOG" 2>&1 || PLAN_EXIT=$?
PLAN_SECONDS=$(($(date +%s) - PLAN_START))
CALL_COUNTS="$(curl -fs "${PROXY_ENDPOINT}/__counts")"
kill "$PROXY_PID" 2>/dev/null || true
trap - EXIT

cat "$PLAN_LOG"
log "plan calls: $CALL_COUNTS"

PLAN_SUMMARY="$(grep -m1 '^Plan for ' "$PLAN_LOG" || true)"
NOOP="$(echo "$PLAN_SUMMARY" | grep -oE '[0-9]+ noop' | grep -oE '[0-9]+' || echo -1)"
CREATE="$(echo "$PLAN_SUMMARY" | grep -oE '[0-9]+ create' | grep -oE '[0-9]+' || echo -1)"
UNOBSERVED="$(echo "$PLAN_SUMMARY" | grep -oE '[0-9]+ unobserved' | grep -oE '[0-9]+' || echo -1)"

PLAN_VERDICT="pass"
if [ "$PLAN_EXIT" -ne 0 ] || [ "$CREATE" != "0" ] || [ "$UNOBSERVED" != "0" ] || [ "$NOOP" != "$RESOURCES_APPLIED" ]; then
  PLAN_VERDICT="fail"
fi
PLAN_DETAIL="create=$CREATE noop=$NOOP unobserved=$UNOBSERVED plan_calls_total=$(echo "$CALL_COUNTS" | jq -c '.total')"
log "plan verdict=$PLAN_VERDICT ($PLAN_DETAIL) in ${PLAN_SECONDS}s"
echo "VERDICT stage=test_plan verdict=$PLAN_VERDICT seconds=$PLAN_SECONDS detail=\"$PLAN_DETAIL\""

# ---- 5. the cost record --------------------------------------------------
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
CALL_TOTAL="$(echo "$CALL_COUNTS" | jq '.total')"
jq -n \
  --argjson schema 1 \
  --arg estate "chant-scale-estate" \
  --arg target "floci" \
  --argjson scale "$STACK_COUNT" \
  --arg commit "$COMMIT" \
  --arg emulator "$IMAGE" \
  --argjson total "$TOTAL_RESOURCES" \
  --argjson taggable "$RESOURCES_APPLIED" \
  --arg deploy_verdict "$DEPLOY_VERDICT" \
  --argjson deploy_seconds "$DEPLOY_SECONDS" \
  --arg deploy_detail "$DONE/$STACK_COUNT stacks, $RESOURCES_APPLIED/$TOTAL_RESOURCES resources" \
  --arg plan_verdict "$PLAN_VERDICT" \
  --argjson plan_seconds "$PLAN_SECONDS" \
  --arg plan_detail "$PLAN_DETAIL" \
  --argjson plan_calls_total "$CALL_TOTAL" \
  --argjson plan_calls_by_action "$(echo "$CALL_COUNTS" | jq -c '.byAction')" \
  --argjson stack_count "$STACK_COUNT" \
  --arg source "test/scale-estate.sh" \
  '{
    schema: $schema,
    estate: $estate,
    target: $target,
    scale: $scale,
    commit: $commit,
    emulator: $emulator,
    resources: { total: $total, taggable: $taggable, skipped: ($total - $taggable) },
    stages: {
      cold_deploy: { verdict: $deploy_verdict, seconds: $deploy_seconds, detail: $deploy_detail },
      test_plan: { verdict: $plan_verdict, seconds: $plan_seconds, detail: $plan_detail }
    },
    plan_calls: {
      total: { choudoufu: $plan_calls_total },
      by_action: $plan_calls_by_action,
      per_stack: ($plan_calls_total / $stack_count)
    },
    source: $source
  }' > "$RECORD_PATH"

log "wrote cost record to $RECORD_PATH"
cat "$RECORD_PATH"

OVERALL_VERDICT="pass"
{ [ "$DEPLOY_VERDICT" = "pass" ] && [ "$PLAN_VERDICT" = "pass" ]; } || OVERALL_VERDICT="fail"
echo "VERDICT overall=$OVERALL_VERDICT"

# ---- 6. teardown ----------------------------------------------------------
if [ "$OVERALL_VERDICT" = "pass" ] && [ "$KEEP" -eq 0 ]; then
  log "=== tearing down $CONTAINER ==="
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
else
  log "leaving $CONTAINER running (overall=$OVERALL_VERDICT keep=$KEEP) — \`test/scale-estate.sh down\` to tear down"
fi

[ "$OVERALL_VERDICT" = "pass" ] && exit 0 || exit 1
