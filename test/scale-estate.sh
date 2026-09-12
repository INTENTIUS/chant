#!/usr/bin/env bash
set -euo pipefail

# chant#2403 — the scale-estate harness (chant-bench#33's chant-side arm).
#
# Builds and deploys a generated multi-stack chant project
# (scripts/generate-scale-estate.ts) against floci, one `chant run` per
# stack — no single-invocation driver deploys N stacks as one estate today
# (see that script's own header) — then reads the estate back THREE ways,
# each measured independently through a counting proxy:
#
#   1. cold_plan — `chant lifecycle plan local`. Unconditionally live: no
#      flag defers it, `--live` doesn't exist for this command (#2405). This
#      is the expensive path: it discovers every stack's own *.component.ts
#      and observes each (packages/core/src/cli/handlers/lifecycle.ts's
#      componentStacks), including the deep held-properties pass.
#   2. snapshot — `chant lifecycle snapshot local`. Also live (it is what
#      populates the cache: two calls per stack, DescribeStackResources +
#      DescribeStacks, nothing per resource), and writes the result to the
#      `chant/lifecycle` orphan git branch (packages/core/src/lifecycle/
#      git.ts).
#   3. warm_diff — `chant lifecycle diff local` (no `--live`). Reads ONLY the
#      ledger `snapshot` just wrote and the current build's digest
#      (`runLifecycleDiffDigest`, cli/handlers/lifecycle.ts) — zero cloud
#      calls. This is the cache #2405 pointed out this harness never
#      exercised: measuring `plan` alone and calling that "chant's read
#      cost" conflates the one path that is unconditionally live with the
#      two that are not.
#
# `chant lifecycle snapshot` needs a real git repository under the generated
# project to write to (`takeSnapshot` reads `git rev-parse HEAD` to stamp the
# snapshot — packages/core/src/lifecycle/snapshot.ts — which fails on an
# unborn HEAD). The generator (scripts/generate-scale-estate.ts) only writes
# files; it has no reason to know about git, and its own unit test asserts
# nothing about a repo, so this harness prepares one itself, idempotently,
# right after generation — see "prepare a git repo" below.
#
# Emits a choudoufu-shaped cost record (schema/estate/target/scale/commit/
# resources/stages/reads) so chant-bench's ingest reads it without a second
# parser: `reads.<name>` is the same `{ calls: { total, by_action }, verdict,
# seconds, detail }` shape for all three of cold_plan/snapshot/warm_diff, so
# one accessor handles any of them. This is schema 2 (was 1): the old
# top-level `plan_calls` (one read, mislabeled under an arm key of
# "choudoufu" even though it was always chant's own number) is replaced by
# `reads.cold_plan.calls`, keyed honestly as "chant". Schema 3 (chant#2409)
# adds `stages.cold_deploy.stacks`, one uniform `{name, seconds, anomaly}`
# entry per stack, plus `median_seconds` — see "the cost record" below.
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
#   - a VERDICT line per read (cold_plan, snapshot, warm_diff) the moment it
#     completes, each carrying its own call count — never collapsed into one
#     number
#
# chant#2409 — the heartbeat's OWN call can hang (it did, once, for 13
# minutes, and everything downstream looked normal before and after): two
# more things stream live rather than surfacing only in hindsight or not at
# all.
#   - a poll that does not answer: the heartbeat's DescribeStackEvents call
#     is bounded (POLL_TIMEOUT_SECONDS below); when it trips, every
#     heartbeat tick says so explicitly ("POLL DID NOT ANSWER") with how
#     long it has been waiting, instead of printing nothing — "nothing is
#     happening yet" and "we cannot see what is happening" must never look
#     the same in the log, and the loop keeps ticking through it rather than
#     blocking on the one call
#   - an outlier while it is still running: each stack's own elapsed time is
#     compared, live, against the median of stacks that have already
#     finished (the first stack has no median yet and is exempt, honestly,
#     rather than compared against a fabricated one); crossing the threshold
#     (OUTLIER_MULTIPLIER / OUTLIER_FLOOR_SECONDS below) is flagged on the
#     spot, with the emulator's log dumped to --out immediately — not queued
#     for a teardown that, per the next point, will not happen
#
# Never destroys the evidence for an anomaly it just found: a stall or an
# outlier suppresses the clean-pass teardown even when every stage passed,
# prints the container name and the exact command to inspect it, and says
# why it was kept. And the published cost record itself carries the same
# per-stack durations, median, and flagged-stack reasons the log streamed —
# a reader of the record alone, not just the log, can see that one stack
# behaved unlike the others.
#
# Resumable: re-running this script against the SAME floci container skips
# every stack `DescribeStacks` already reports CREATE_COMPLETE/
# UPDATE_COMPLETE, and skips re-generating the project if its manifest
# already exists. A run that dies at stack 14 of 20 picks up at 14 on the
# next invocation, not 1 — as long as the container from the first attempt
# is still up (a failed/interrupted run leaves it running on purpose; only
# a clean full pass with no anomaly tears it down, unless --keep is given).
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
#                             clean pass (default: tear down only on a clean,
#                             ANOMALY-FREE pass — chant#2409: a stall or an
#                             outlier keeps the container up on its own,
#                             whether or not --keep was given, the same as a
#                             failed/stopped run always has).
#     --force                regenerate the project even if a manifest
#                             already exists at --out.
#
# Needs: docker, the aws CLI, jq, node, npx. Never talks to real AWS — every
# AWS_ENDPOINT_URL this script sets points at floci or at its own counting
# proxy in front of floci.
#
# Two test seams, chant#2409, both no-ops by default (unset = the same real
# floci endpoint everything already used) — proving this file's own
# behavior needs to move ONE call at a time onto a deliberately misbehaving
# stand-in without disturbing the rest of the run:
#   env HEARTBEAT_ENDPOINT_URL — retargets only the heartbeat's own
#     DescribeStackEvents call (count_landed_resources). Point it at
#     scripts/api-call-proxy.mjs with STALL_ACTION=DescribeStackEvents to
#     prove the poll-timeout/anomaly behavior against a call that
#     reproducibly does not answer, rather than waiting on a repeat of the
#     incident that opened #2409.
#   env DEPLOY_ENDPOINT_URL — retargets everything else chant#2409 doesn't
#     touch (chant build, chant run, stack_status, first_failure_of). Point
#     it at api-call-proxy.mjs with STALL_DELAY_MS to make one stack's own
#     deploy genuinely, honestly slower (e.g. a delayed CreateStack), so the
#     live outlier-vs-median detection can be proven against a real
#     duration outlier — independent of, and without touching, the
#     heartbeat's own poll.
# Setting either has no effect on the other call.

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
# Not PORT+1: a neighboring probe/compose stack routinely claims that port
# (observed live during this unit's own development — see the harness's own
# doc comment above). PORT+7 keeps clear of every *_PORT this repo's other
# on-demand e2e scripts default to (aws-cc-e2e.sh's 4598, components-aws-e2e's
# 4599, floci's own 4566) without a registry to check against.
PROXY_PORT=""
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
    --proxy-port) PROXY_PORT="$2"; shift 2 ;;
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
PROXY_PORT="${PROXY_PORT:-$((PORT + 7))}"
PROXY_ENDPOINT="http://localhost:${PROXY_PORT}"
# chant#2409 test seam: defaults to the real floci endpoint, so with no
# override this is a no-op and behavior is unchanged. See the header comment.
HEARTBEAT_ENDPOINT="${HEARTBEAT_ENDPOINT_URL:-$ENDPOINT}"

# ---- chant#2409: stall/outlier thresholds --------------------------------
# The heartbeat's own DescribeStackEvents call. 5s: long enough to absorb
# floci's ordinary jitter under load (a bare `sleep 3` between ticks already
# gives it breathing room), short enough that #2409's 13-minute hang is
# caught on its very first tick instead of after hundreds of silent retries.
POLL_TIMEOUT_SECONDS=5
# A stack's own elapsed time vs. the median of stacks that have ALREADY
# finished. #2409's real outlier was ~113x the median (791s vs ~7s) — 8x
# catches that with enormous margin while tolerating the 2-3x jitter a
# shared docker host produces under ordinary load. The 20s floor exists
# because 8x of a very fast median (a nearly-empty stack can finish in 1-2s)
# would fire on noise alone; nothing under 20s is worth interrupting a run
# to investigate.
OUTLIER_MULTIPLIER=8
OUTLIER_FLOOR_SECONDS=20

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
# chant#2409 test seam (see HEARTBEAT_ENDPOINT above): defaults to floci
# itself, so this is a no-op unless a test deliberately overrides it. Lets
# chant's OWN calls (build/run/stack_status — everything except the
# heartbeat's own poll) be pointed at a stand-in that delays one call
# genuinely, so a real (not fabricated) duration outlier can be proven on
# its own, independent of and without touching the poll-timeout path above.
export AWS_ENDPOINT_URL="${DEPLOY_ENDPOINT_URL:-$ENDPOINT}"

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

# ---- 2b. prepare a git repo, idempotent --------------------------------
# `chant lifecycle snapshot` (packages/core/src/lifecycle/snapshot.ts's
# `takeSnapshot`) calls `getHeadCommit()` — a bare `git rev-parse HEAD` — to
# stamp the snapshot it writes with the commit it was taken against. An
# unborn HEAD (a `git init` with no commit yet) fails that call outright, so
# `chant lifecycle snapshot local` cannot run against a freshly generated
# project with no git history. The generator itself
# (scripts/generate-scale-estate.ts) only writes files and its own unit test
# (generate-scale-estate.test.ts) asserts nothing about git, so entangling it
# with a subprocess for one lifecycle command's benefit would be the wrong
# layer — this harness prepares the repo instead, once, right after
# generation. `-c user.name`/`-c user.email` on this one commit only (not
# written to config) so this works unattended in a container with no git
# identity configured; every later ledger write chant itself makes falls
# back the same way on its own (git.ts's `ledgerCommitIdentityArgs`, #2301).
if [ ! -d "$OUT/.git" ]; then
  git -C "$OUT" init -q
  printf 'node_modules/\nsrc/*/template.json\n' > "$OUT/.gitignore"
  git -C "$OUT" add -A
  git -C "$OUT" -c user.name="chant-scale-estate" -c user.email="chant-scale-estate@localhost" \
    commit -q -m "chant#2403 scale estate: generated project ($STACK_COUNT stacks, $TOTAL_RESOURCES resources)"
  log "git-initialized $OUT ($(git -C "$OUT" rev-parse --short HEAD)) so lifecycle snapshot can stamp a HEAD commit"
else
  log "$OUT already a git repo ($(git -C "$OUT" rev-parse --short HEAD)) — reusing (resumable)"
fi

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
#
# chant#2409: bounded by POLL_TIMEOUT_SECONDS on both connect and read, and
# targets HEARTBEAT_ENDPOINT (normally == floci, see the header comment) so
# this one call can be pointed at a deliberately-hanging stand-in for proof.
# Before #2409 a failed call here was swallowed to a bare "0", printing the
# exact same line a genuinely idle stack would — this now prints the literal
# string "TIMEOUT" instead, so the caller (and the heartbeat log line it
# drives) can tell "0 landed so far" from "the call did not answer" rather
# than collapsing both into the same silence.
#
# "Failed" is NOT the same as "didn't answer": in the first second or two
# after `chant run` issues CreateStack, DescribeStackEvents on a stack floci
# hasn't finished registering yet legitimately fails with an ordinary
# ValidationError ("Stack ... does not exist") — that's "0 landed so far",
# the same as before #2409, not an anomaly. Only botocore's own read/connect
# timeout (an aws-cli process that gave up waiting, distinct stderr text) is
# "TIMEOUT" — checked directly rather than inferred from "any error", so an
# ordinary transient error during normal startup is never misreported as a
# stall.
#
# AWS_MAX_ATTEMPTS=1: botocore retries a read/connect timeout automatically
# (3 attempts by default, each up to POLL_TIMEOUT_SECONDS, with backoff in
# between) — left alone, a single stalled tick could silently cost 15-20+
# seconds of hidden, unreported retrying before this function returns at
# all, which is exactly the kind of blind wait #2409 exists to end. Forcing
# one attempt makes the bound real: this call returns (with an answer, or
# with "it didn't answer") within POLL_TIMEOUT_SECONDS, full stop, so the
# heartbeat's own reporting interval means what it says.
count_landed_resources() { # $1 = stack name
  local out err_file
  err_file="$(mktemp)"
  out="$(AWS_ENDPOINT_URL="$HEARTBEAT_ENDPOINT" AWS_MAX_ATTEMPTS=1 aws cloudformation describe-stack-events --stack-name "$1" \
      --cli-connect-timeout "$POLL_TIMEOUT_SECONDS" --cli-read-timeout "$POLL_TIMEOUT_SECONDS" 2>"$err_file" \
      | jq '[.StackEvents[] | select(.ResourceStatus | test("_COMPLETE$")) | select(.ResourceType != "AWS::CloudFormation::Stack") | .LogicalResourceId] | unique | length' \
      2>/dev/null)" || true
  if [ -n "$out" ]; then
    echo "$out"
  elif grep -qi 'timeout' "$err_file"; then
    echo "TIMEOUT"
  else
    echo 0
  fi
  rm -f "$err_file"
}

# chant#2409 bookkeeping, populated as stacks complete (never for a
# resumed/already-complete stack — its "duration" this run is ~0 and would
# only pollute the median). RUN_STACK_ANOMALY holds "" for a clean stack or
# the flagged reason, parallel by index to the other two.
RUN_STACK_NAMES=()
RUN_STACK_SECONDS=()
RUN_STACK_ANOMALY=()
ANOMALY_DETECTED=0
ANOMALY_STACKS=()
ANOMALY_REASONS_LIST=()

record_stack_duration() { # $1=stack $2=seconds $3=anomaly reason ("" if none)
  RUN_STACK_NAMES+=("$1")
  RUN_STACK_SECONDS+=("$2")
  RUN_STACK_ANOMALY+=("$3")
}

# Median of the given integers (floor of the average for an even count).
# Callers must not invoke this with zero arguments — chant#2409's first
# stack has no prior durations to compare against, and manufacturing a
# baseline from nothing would be worse than admitting there isn't one yet.
median_of() {
  printf '%s\n' "$@" | sort -n | awk -v n="$#" '{a[NR]=$1} END { if (n % 2 == 1) print a[(n+1)/2]; else print int((a[n/2]+a[n/2+1])/2) }'
}

# chant#2409: marks the run as having witnessed an anomaly (a stall, an
# outlier — either) and captures, right now, the one piece of evidence a
# clean-pass teardown would otherwise destroy: the emulator's own log.
# Idempotent per call site (deploy_one_stack only calls this once per stack,
# on whichever condition trips first) so one stack can't dump twice.
flag_anomaly() { # $1=stack $2=reason
  local stack="$1" reason="$2" dump
  ANOMALY_DETECTED=1
  ANOMALY_STACKS+=("$stack")
  ANOMALY_REASONS_LIST+=("$reason")
  dump="$OUT/../anomaly-${stack}-$(date +%s).log"
  docker logs "$CONTAINER" >"$dump" 2>&1 || true
  log "  !!! ANOMALY [$stack]: $reason"
  log "  !!! dumped $CONTAINER's log to $dump now — not waiting for a teardown that will not happen for this run (chant#2409)"
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
  local ANOMALY_REASON="" POLL_STALL_SINCE=0 NOW WAITING MEDIAN_SO_FAR THRESHOLD

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
  if [ "${#RUN_STACK_SECONDS[@]}" -eq 0 ]; then
    log "  (no finished stacks yet — chant#2409 outlier detection starts once one completes; this one is exempt)"
  fi
  STACK_START=$(date +%s)
  DEPLOY_LOG="$(mktemp)"
  "$CHANT" run --components "$STACK" --env local --no-release-record >"$DEPLOY_LOG" 2>&1 &
  DEPLOY_PID=$!

  # Heartbeat: poll the stack's own events while chant's apply is in flight —
  # never a blind, silent wait on the child process. chant#2409: the poll
  # itself can hang (count_landed_resources is bounded and reports
  # "TIMEOUT" rather than swallowing the failure), and separately, this
  # stack's own elapsed time is compared live against the median of stacks
  # that have already finished — both conditions are said out loud the
  # moment they're seen, not after the fact.
  while kill -0 "$DEPLOY_PID" 2>/dev/null; do
    sleep 3
    LANDED="$(count_landed_resources "$STACK")"
    HB_ELAPSED=$(($(date +%s) - STACK_START))

    if [ "$LANDED" = "TIMEOUT" ]; then
      NOW=$(date +%s)
      [ "$POLL_STALL_SINCE" -eq 0 ] && POLL_STALL_SINCE=$NOW
      WAITING=$((NOW - POLL_STALL_SINCE + POLL_TIMEOUT_SECONDS))
      log "  ... $STACK: POLL DID NOT ANSWER — DescribeStackEvents exceeded ${POLL_TIMEOUT_SECONDS}s, waiting ${WAITING}s so far (stack running ${HB_ELAPSED}s)"
      if [ -z "$ANOMALY_REASON" ]; then
        ANOMALY_REASON="heartbeat poll did not answer within ${POLL_TIMEOUT_SECONDS}s (first seen at ${HB_ELAPSED}s into this stack)"
        flag_anomaly "$STACK" "$ANOMALY_REASON"
      fi
    else
      POLL_STALL_SINCE=0
      log "  ... $STACK: ${LANDED:-0}/$RES_COUNT resources landed (${HB_ELAPSED}s)"
    fi

    if [ -z "$ANOMALY_REASON" ] && [ "${#RUN_STACK_SECONDS[@]}" -gt 0 ]; then
      MEDIAN_SO_FAR="$(median_of "${RUN_STACK_SECONDS[@]}")"
      THRESHOLD=$((MEDIAN_SO_FAR * OUTLIER_MULTIPLIER))
      [ "$THRESHOLD" -lt "$OUTLIER_FLOOR_SECONDS" ] && THRESHOLD=$OUTLIER_FLOOR_SECONDS
      if [ "$HB_ELAPSED" -gt "$THRESHOLD" ]; then
        ANOMALY_REASON="${HB_ELAPSED}s so far vs a median of ${MEDIAN_SO_FAR}s from ${#RUN_STACK_SECONDS[@]} finished stack(s) — over ${OUTLIER_MULTIPLIER}x (floor ${OUTLIER_FLOOR_SECONDS}s)"
        log "  !!! OUTLIER: $STACK is at ${HB_ELAPSED}s against a median of ${MEDIAN_SO_FAR}s (threshold ${THRESHOLD}s) — flagging now, while it is still running"
        flag_anomaly "$STACK" "$ANOMALY_REASON"
      fi
    fi
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
    record_stack_duration "$STACK" "$STACK_SECONDS" "$ANOMALY_REASON"
    return 1
  fi

  FINAL_STATUS="$(stack_status "$STACK")"
  if [ "$FINAL_STATUS" != "CREATE_COMPLETE" ]; then
    DETAIL="$(first_failure_of "$STACK")"
    log "FAIL [$STACK]: chant run exited 0 but stack status is $FINAL_STATUS, expected CREATE_COMPLETE"
    [ -n "$DETAIL" ] && log "  first failure: $DETAIL"
    record_stack_duration "$STACK" "$STACK_SECONDS" "$ANOMALY_REASON"
    return 1
  fi

  DONE=$((DONE + 1))
  RESOURCES_APPLIED=$((RESOURCES_APPLIED + RES_COUNT))
  log "stack $IDX/$STACK_COUNT: $STACK done $FINAL_STATUS ($RES_COUNT resources) in ${STACK_SECONDS}s"
  record_stack_duration "$STACK" "$STACK_SECONDS" "$ANOMALY_REASON"
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
  echo "VERDICT stage=read_cold_plan verdict=not_run seconds=0 detail=\"skipped: cold_deploy did not complete\""
  echo "VERDICT stage=read_snapshot verdict=not_run seconds=0 detail=\"skipped: cold_deploy did not complete\""
  echo "VERDICT stage=read_warm_diff verdict=not_run seconds=0 detail=\"skipped: cold_deploy did not complete\""
  echo "VERDICT overall=fail"
  exit 1
fi

# ---- 4. read the estate back THREE ways, each measured independently ----
# chant#2405: a live `lifecycle plan` and a cache-backed `lifecycle diff` are
# not the same read. One proxy, reset before each read so every call count
# below is exactly what that one command cost — never a running total, never
# collapsed into one number. Order matters: cold_plan first (nothing cached
# yet), snapshot second (this IS the cache write), warm_diff third (reads
# only what snapshot just wrote).
log "=== read-back: three reads, each proxy-counted independently ==="
PROXY_PORT="$PROXY_PORT" TARGET_PORT="$PORT" node "$ROOT/scripts/api-call-proxy.mjs" >"$OUT/.api-call-proxy.log" 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
i=0
until curl -fs "${PROXY_ENDPOINT}/__counts" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 20 ] && { log "FAIL [proxy]: api-call-proxy.mjs did not come up"; cat "$OUT/.api-call-proxy.log"; exit 1; }
  sleep 0.5
done

reset_counts() { curl -fs -X POST "${PROXY_ENDPOINT}/__reset" >/dev/null; }
read_counts() { curl -fs "${PROXY_ENDPOINT}/__counts"; }

# ---- 4a. cold_plan: chant lifecycle plan local (unconditionally live) ---
log "--- read 1/3: cold_plan — chant lifecycle plan local ---"
reset_counts
PLAN_START=$(date +%s)
PLAN_LOG="$(mktemp)"
PLAN_EXIT=0
AWS_ENDPOINT_URL="$PROXY_ENDPOINT" "$CHANT" lifecycle plan local >"$PLAN_LOG" 2>&1 || PLAN_EXIT=$?
PLAN_SECONDS=$(($(date +%s) - PLAN_START))
PLAN_CALLS="$(read_counts)"
cat "$PLAN_LOG"
log "cold_plan calls: $PLAN_CALLS"

PLAN_SUMMARY="$(grep -m1 '^Plan for ' "$PLAN_LOG" || true)"
PLAN_NOOP="$(echo "$PLAN_SUMMARY" | grep -oE '[0-9]+ noop' | grep -oE '[0-9]+' || echo -1)"
PLAN_CREATE="$(echo "$PLAN_SUMMARY" | grep -oE '[0-9]+ create' | grep -oE '[0-9]+' || echo -1)"
PLAN_UNOBSERVED="$(echo "$PLAN_SUMMARY" | grep -oE '[0-9]+ unobserved' | grep -oE '[0-9]+' || echo -1)"
PLAN_CALLS_TOTAL="$(echo "$PLAN_CALLS" | jq '.total')"

PLAN_VERDICT="pass"
if [ "$PLAN_EXIT" -ne 0 ] || [ "$PLAN_CREATE" != "0" ] || [ "$PLAN_UNOBSERVED" != "0" ] || [ "$PLAN_NOOP" != "$RESOURCES_APPLIED" ]; then
  PLAN_VERDICT="fail"
fi
PLAN_DETAIL="create=$PLAN_CREATE noop=$PLAN_NOOP unobserved=$PLAN_UNOBSERVED calls_total=$PLAN_CALLS_TOTAL"
log "cold_plan verdict=$PLAN_VERDICT ($PLAN_DETAIL) in ${PLAN_SECONDS}s"
echo "VERDICT stage=read_cold_plan verdict=$PLAN_VERDICT seconds=$PLAN_SECONDS calls=$PLAN_CALLS_TOTAL detail=\"$PLAN_DETAIL\""

# ---- 4b. snapshot: chant lifecycle snapshot local (live; writes the cache) -
# Two calls per stack (DescribeStackResources + DescribeStacks), nothing per
# resource — and needs the git repo step 2b prepared: `takeSnapshot` stamps
# the snapshot with `git rev-parse HEAD`.
log "--- read 2/3: snapshot — chant lifecycle snapshot local ---"
reset_counts
SNAPSHOT_START=$(date +%s)
SNAPSHOT_LOG="$(mktemp)"
SNAPSHOT_EXIT=0
AWS_ENDPOINT_URL="$PROXY_ENDPOINT" "$CHANT" lifecycle snapshot local >"$SNAPSHOT_LOG" 2>&1 || SNAPSHOT_EXIT=$?
SNAPSHOT_SECONDS=$(($(date +%s) - SNAPSHOT_START))
SNAPSHOT_CALLS="$(read_counts)"
cat "$SNAPSHOT_LOG"
log "snapshot calls: $SNAPSHOT_CALLS"

SNAPSHOT_SAVED="$(grep -c 'Snapshot saved to chant/lifecycle' "$SNAPSHOT_LOG" || true)"
SNAPSHOT_CALLS_TOTAL="$(echo "$SNAPSHOT_CALLS" | jq '.total')"

SNAPSHOT_VERDICT="pass"
if [ "$SNAPSHOT_EXIT" -ne 0 ] || [ "$SNAPSHOT_SAVED" != "$STACK_COUNT" ]; then
  SNAPSHOT_VERDICT="fail"
fi
SNAPSHOT_DETAIL="saved=$SNAPSHOT_SAVED/$STACK_COUNT calls_total=$SNAPSHOT_CALLS_TOTAL"
log "snapshot verdict=$SNAPSHOT_VERDICT ($SNAPSHOT_DETAIL) in ${SNAPSHOT_SECONDS}s"
echo "VERDICT stage=read_snapshot verdict=$SNAPSHOT_VERDICT seconds=$SNAPSHOT_SECONDS calls=$SNAPSHOT_CALLS_TOTAL detail=\"$SNAPSHOT_DETAIL\""

# ---- 4c. warm_diff: chant lifecycle diff local, no --live ----------------
# The warm path: reads only the ledger `snapshot` just wrote and the current
# build's digest (`runLifecycleDiffDigest`) — no cloud call at all. This is
# the read #2405 says this harness never exercised before.
log "--- read 3/3: warm_diff — chant lifecycle diff local ---"
reset_counts
DIFF_START=$(date +%s)
DIFF_LOG="$(mktemp)"
DIFF_EXIT=0
AWS_ENDPOINT_URL="$PROXY_ENDPOINT" "$CHANT" lifecycle diff local >"$DIFF_LOG" 2>&1 || DIFF_EXIT=$?
DIFF_SECONDS=$(($(date +%s) - DIFF_START))
DIFF_CALLS="$(read_counts)"
kill "$PROXY_PID" 2>/dev/null || true
trap - EXIT
cat "$DIFF_LOG"
log "warm_diff calls: $DIFF_CALLS"

# The RESOURCE column is `name.padEnd(20)` (runLifecycleDiffDigest,
# cli/handlers/lifecycle.ts) — a floor, not a fixed width, and every
# generated name here (e.g. "scale_stack_003_team029Role") is already past
# 20 characters, so name and STATUS end up glued with no separator at all
# ("...team029Roleunchanged"). Splitting on whitespace between them (an
# earlier version of this script did) silently sees zero rows of every
# status. Anchor on the TYPE column instead — always space-separated from
# STATUS, since every status word is short — and disambiguate "changed" from
# "unchanged" by checking the longer suffix first.
DIFF_STATUS_COUNTS="$(awk '
  /AWS::/ {
    line = $0
    sub(/AWS::.*/, "", line)
    gsub(/[ \t]+$/, "", line)
    if (line ~ /unchanged$/) unchanged++
    else if (line ~ /changed$/) changed++
    else if (line ~ /added$/) added++
    else if (line ~ /removed$/) removed++
  }
  END { printf "%d %d %d %d\n", unchanged+0, changed+0, added+0, removed+0 }
' "$DIFF_LOG")"
read -r DIFF_UNCHANGED DIFF_CHANGED DIFF_ADDED DIFF_REMOVED <<<"$DIFF_STATUS_COUNTS"
DIFF_CALLS_TOTAL="$(echo "$DIFF_CALLS" | jq '.total')"

DIFF_VERDICT="pass"
if [ "$DIFF_EXIT" -ne 0 ] || [ "$DIFF_CALLS_TOTAL" != "0" ] || [ "$DIFF_CHANGED" != "0" ] || [ "$DIFF_ADDED" != "0" ] || [ "$DIFF_REMOVED" != "0" ] || [ "$DIFF_UNCHANGED" != "$RESOURCES_APPLIED" ]; then
  DIFF_VERDICT="fail"
fi
DIFF_DETAIL="unchanged=$DIFF_UNCHANGED changed=$DIFF_CHANGED added=$DIFF_ADDED removed=$DIFF_REMOVED calls_total=$DIFF_CALLS_TOTAL"
log "warm_diff verdict=$DIFF_VERDICT ($DIFF_DETAIL) in ${DIFF_SECONDS}s"
echo "VERDICT stage=read_warm_diff verdict=$DIFF_VERDICT seconds=$DIFF_SECONDS calls=$DIFF_CALLS_TOTAL detail=\"$DIFF_DETAIL\""

# ---- 5. the cost record --------------------------------------------------
# schema 3 (was 2): chant#2409 adds `stages.cold_deploy.stacks` — one entry
# per stack actually deployed this run (name, seconds, and `anomaly`: null
# for a clean stack or the flagged reason string), plus the run's
# `median_seconds`. Same discipline schema 2 already set for `reads`: one
# uniform per-item shape (here `{name, seconds, anomaly}`), so chant-bench's
# ingest can tell "one stack behaved unlike the others" straight from the
# record — filter `stacks[]` for `anomaly != null` — without a second parser
# or falling back to the log.
#
# schema 2 (was 1): the old single `plan_calls` field — one read, keyed under
# an arm name of "choudoufu" even though the number was always chant's own —
# is replaced by `reads`, an object with the SAME `{ calls: { total,
# by_action }, verdict, seconds, detail }` shape for all three of
# cold_plan/snapshot/warm_diff (one accessor handles any of them), keyed
# honestly as "chant".
STACK_DURATIONS_NDJSON="$(mktemp)"
: > "$STACK_DURATIONS_NDJSON"
for i in "${!RUN_STACK_NAMES[@]}"; do
  jq -n \
    --arg name "${RUN_STACK_NAMES[$i]}" \
    --argjson seconds "${RUN_STACK_SECONDS[$i]}" \
    --arg anomaly "${RUN_STACK_ANOMALY[$i]}" \
    '{name: $name, seconds: $seconds, anomaly: (if $anomaly == "" then null else $anomaly end)}' \
    >> "$STACK_DURATIONS_NDJSON"
done
STACK_DURATIONS_JSON="$(jq -s '.' "$STACK_DURATIONS_NDJSON")"
rm -f "$STACK_DURATIONS_NDJSON"
if [ "${#RUN_STACK_SECONDS[@]}" -gt 0 ]; then
  RECORD_MEDIAN_SECONDS="$(median_of "${RUN_STACK_SECONDS[@]}")"
else
  RECORD_MEDIAN_SECONDS="null"
fi

COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
jq -n \
  --argjson schema 3 \
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
  --argjson deploy_stacks "$STACK_DURATIONS_JSON" \
  --argjson deploy_median_seconds "$RECORD_MEDIAN_SECONDS" \
  --argjson anomaly_detected "$([ "$ANOMALY_DETECTED" -eq 1 ] && echo true || echo false)" \
  --arg plan_command "chant lifecycle plan local" \
  --arg plan_verdict "$PLAN_VERDICT" \
  --argjson plan_seconds "$PLAN_SECONDS" \
  --arg plan_detail "$PLAN_DETAIL" \
  --argjson plan_calls_total "$PLAN_CALLS_TOTAL" \
  --argjson plan_calls_by_action "$(echo "$PLAN_CALLS" | jq -c '.byAction')" \
  --arg snapshot_command "chant lifecycle snapshot local" \
  --arg snapshot_verdict "$SNAPSHOT_VERDICT" \
  --argjson snapshot_seconds "$SNAPSHOT_SECONDS" \
  --arg snapshot_detail "$SNAPSHOT_DETAIL" \
  --argjson snapshot_calls_total "$SNAPSHOT_CALLS_TOTAL" \
  --argjson snapshot_calls_by_action "$(echo "$SNAPSHOT_CALLS" | jq -c '.byAction')" \
  --arg diff_command "chant lifecycle diff local" \
  --arg diff_verdict "$DIFF_VERDICT" \
  --argjson diff_seconds "$DIFF_SECONDS" \
  --arg diff_detail "$DIFF_DETAIL" \
  --argjson diff_calls_total "$DIFF_CALLS_TOTAL" \
  --argjson diff_calls_by_action "$(echo "$DIFF_CALLS" | jq -c '.byAction')" \
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
      cold_deploy: {
        verdict: $deploy_verdict,
        seconds: $deploy_seconds,
        detail: $deploy_detail,
        stacks: $deploy_stacks,
        median_seconds: $deploy_median_seconds,
        anomaly_detected: $anomaly_detected
      }
    },
    reads: {
      cold_plan: {
        command: $plan_command,
        verdict: $plan_verdict,
        seconds: $plan_seconds,
        detail: $plan_detail,
        calls: { total: { chant: $plan_calls_total }, by_action: $plan_calls_by_action },
        per_stack: ($plan_calls_total / $stack_count)
      },
      snapshot: {
        command: $snapshot_command,
        verdict: $snapshot_verdict,
        seconds: $snapshot_seconds,
        detail: $snapshot_detail,
        calls: { total: { chant: $snapshot_calls_total }, by_action: $snapshot_calls_by_action },
        per_stack: ($snapshot_calls_total / $stack_count)
      },
      warm_diff: {
        command: $diff_command,
        verdict: $diff_verdict,
        seconds: $diff_seconds,
        detail: $diff_detail,
        calls: { total: { chant: $diff_calls_total }, by_action: $diff_calls_by_action },
        per_stack: ($diff_calls_total / $stack_count)
      }
    },
    source: $source
  }' > "$RECORD_PATH"

log "wrote cost record to $RECORD_PATH"
cat "$RECORD_PATH"

OVERALL_VERDICT="pass"
{ [ "$DEPLOY_VERDICT" = "pass" ] && [ "$PLAN_VERDICT" = "pass" ] && [ "$SNAPSHOT_VERDICT" = "pass" ] && [ "$DIFF_VERDICT" = "pass" ]; } || OVERALL_VERDICT="fail"
echo "VERDICT overall=$OVERALL_VERDICT"

# ---- 6. teardown ----------------------------------------------------------
# chant#2409: an anomaly (a stall, an outlier — either) suppresses teardown
# even on an otherwise-clean pass. The incident that opened this issue had
# exactly that shape — overall=pass, one stack behaved nothing like the
# others — and the container went down anyway, taking the only evidence
# that could have explained it with it.
if [ "$OVERALL_VERDICT" = "pass" ] && [ "$KEEP" -eq 0 ] && [ "$ANOMALY_DETECTED" -eq 0 ]; then
  log "=== tearing down $CONTAINER ==="
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
elif [ "$ANOMALY_DETECTED" -eq 1 ]; then
  log "leaving $CONTAINER running: an anomaly was flagged this run (overall=$OVERALL_VERDICT) — chant#2409 never tears down after one, pass or not"
  for i in "${!ANOMALY_STACKS[@]}"; do
    log "  anomaly: ${ANOMALY_STACKS[$i]}: ${ANOMALY_REASONS_LIST[$i]}"
  done
  log "  inspect its log with: docker logs $CONTAINER"
  log "  or get a shell in it with: docker exec -it $CONTAINER /bin/sh"
  log "  tear down when done: test/scale-estate.sh down $CONTAINER"
else
  log "leaving $CONTAINER running (overall=$OVERALL_VERDICT keep=$KEEP) — \`test/scale-estate.sh down\` to tear down"
fi

[ "$OVERALL_VERDICT" = "pass" ] && exit 0 || exit 1
