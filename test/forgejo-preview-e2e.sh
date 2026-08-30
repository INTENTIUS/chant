#!/usr/bin/env bash
set -euo pipefail

# Forgejo preview E2E: run the per-PR preview loop (chant #1223) end to end on
# a real Actions runner, against a live emulator.
#
# The fixture (test/forgejo-preview-e2e) is the forgejo-dialect twin of
# examples/github-pr-preview: a workflow DECLARED IN CHANT with a deploy job
# gated on `github.event.action != 'closed'` and a teardown job gated on
# `== 'closed'`. This script:
#
#   1. builds the workflow (`.forgejo/workflows/preview.yml`) from ./src,
#   2. packs @intentius/chant + the fly and temporal lexicons into tarballs
#      and assembles a consuming chant project around them,
#   3. boots mudflaps (the Fly Machines API emulator) on a dedicated Docker
#      network, reachable as `http://mudflaps:4280` from job containers,
#   4. drives the workflow twice through a runner with stubbed PR event
#      payloads — `pull_request` opened, then closed,
#   5. asserts against the emulator's API from the host: the PR's app and
#      machine EXIST after the open run, and are GONE after the close run.
#
# That proves the whole contract: the runner honors the action gates, the
# on-open job builds with `--param env=pr-<n>` (via CHANT_ENV) and applies
# through the local Op executor, the ownership marker lands on the live
# machine, and the on-close `chant lifecycle teardown pr-<n> --yes` sweeps
# exactly that marker.
#
# Runner: `act` (nektos/act — the engine Forgejo's own runner wraps) drives
# PR events with `-e <payload>`. `forgejo-runner`/`act_runner` `exec` is used
# when it advertises an event-payload flag; a runner that cannot inject a PR
# event payload is a clean skip, not a failure.
#
# On-demand only — NOT part of the gating CI. Needs Docker + network (the job
# containers npm-install transitive deps from the registry). Run it yourself:
#
#   just forgejo-preview-e2e        (or)   bash test/forgejo-preview-e2e.sh
#
# Override the job image with FORGEJO_E2E_IMAGE (default node:20-bookworm;
# it must have node, npm, and git).
#
# Exit codes: 0 pass or cleanly skipped (no Docker / no capable runner);
# non-zero on a real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT/test/forgejo-preview-e2e"
# node:20-bookworm (not -slim): `chant run` wants a git repo, and a real
# runner image ships git the same way.
IMAGE="${FORGEJO_E2E_IMAGE:-node:20-bookworm}"
MUDFLAPS_IMAGE="$(node -e "process.stdout.write(require('fs').readFileSync('$ROOT/lexicons/fly/src/op/activities/emulator-images.ts','utf8').match(/MUDFLAPS_IMAGE = \"([^\"]+)\"/)[1])")"
PR_ENV="pr-7"
APP="preview-$PR_ENV"

skip() { echo "SKIP: $1"; exit 0; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

# Pick a runner that can inject a PR event payload. act takes the event name
# as its first argument plus `-e <file>`; the Forgejo runners' `exec` is only
# usable here when it advertises an event-file flag.
RUNNER=""
RUNNER_KIND=""
for cand in act forgejo-runner act_runner; do
  command -v "$cand" >/dev/null 2>&1 || continue
  if [ "$cand" = "act" ]; then
    RUNNER="$cand"; RUNNER_KIND="act"; break
  elif "$cand" exec --help 2>&1 | grep -q -- "--event-file"; then
    RUNNER="$cand"; RUNNER_KIND="exec"; break
  fi
done
[ -n "$RUNNER" ] || skip "no runner that can inject a PR event payload (install act, or a forgejo-runner/act_runner whose exec supports --event-file)"

WORK="$(mktemp -d)"
NET="chant-preview-e2e-$$"
MF="chant-preview-e2e-mudflaps-$$"
cleanup() {
  docker rm -f "$MF" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 1. Build the fixture workflow → .forgejo/workflows/preview.yml ───────────
echo "=== Building fixture workflow ==="
npx tsx "$FIXTURE/build.ts" "$WORK"
echo "--- generated .forgejo/workflows/preview.yml ---"
cat "$WORK/.forgejo/workflows/preview.yml"
echo "------------------------------------------------"

# ── 2. Assemble the consuming project ────────────────────────────────────────
# The job containers get everything from the copied-in repo: the project
# sources and the freshly packed chant tarballs (npm pack runs each package's
# prepack, so the tarballs are publish-shaped).
echo "=== Packing chant tarballs ==="
cp -R "$FIXTURE/project/." "$WORK/"
mkdir -p "$WORK/packs"
( cd "$ROOT" && npm pack --silent --pack-destination "$WORK/packs" \
    -w @intentius/chant \
    -w @intentius/chant-lexicon-fly \
    -w @intentius/chant-lexicon-temporal )
ls -la "$WORK/packs"

# A runner expects a git repo at the root.
( cd "$WORK" && git init -q && git add -A && git -c user.email=e2e@chant -c user.name=chant commit -qm fixture )

# ── 3. Boot mudflaps on a dedicated network ──────────────────────────────────
# Job containers resolve it as `mudflaps` (the workflow's FLY_FLAPS_BASE_URL);
# the host asserts through the published 127.0.0.1:4280.
echo "=== Booting mudflaps ($MUDFLAPS_IMAGE) ==="
docker network create "$NET" >/dev/null
docker run -d --name "$MF" --network "$NET" --network-alias mudflaps \
  -p 127.0.0.1:4280:4280 "$MUDFLAPS_IMAGE" >/dev/null
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:4280/_mudflaps/health" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "FAIL: mudflaps did not become healthy"; exit 1; }
  sleep 1
done
echo "mudflaps healthy"

# ── 4a. PR opened → the deploy job must run and apply ────────────────────────
run_workflow() {
  local event_file="$1" log="$2"
  cd "$WORK"
  case "$RUNNER_KIND" in
    act)
      # --bind mounts the fixture repo into the job container (act only
      # copies the repo in when the workflow has a checkout step, and this
      # workflow deliberately has no `uses:`).
      "$RUNNER" pull_request -e "$event_file" \
        -W .forgejo/workflows/preview.yml \
        -P "ubuntu-latest=$IMAGE" -P "docker=$IMAGE" \
        --network "$NET" --pull=false --bind 2>&1 | tee "$log"
      ;;
    exec)
      "$RUNNER" exec -W .forgejo/workflows/preview.yml \
        --event pull_request --event-file "$event_file" \
        -P "docker=$IMAGE" --network "$NET" 2>&1 | tee "$log"
      ;;
  esac
}

echo "=== Running workflow: pull_request opened ($RUNNER) ==="
OPEN_LOG="$WORK/open.log"
if ! run_workflow "$FIXTURE/events/pr-opened.json" "$OPEN_LOG"; then
  echo "FAIL: the runner reported a job failure on the opened event"
  exit 1
fi
grep -q "DEPLOY-OK $PR_ENV" "$OPEN_LOG" || { echo "FAIL: deploy job did not run to completion"; exit 1; }
if grep -q "TEARDOWN-OK" "$OPEN_LOG"; then
  echo "FAIL: teardown job ran on the opened event — the action gate is broken"
  exit 1
fi

# The env's resources exist: the app is listed and its machine is started,
# carrying the ownership marker for exactly this env.
echo "=== Asserting $APP exists on the emulator ==="
APPS_JSON="$(curl -fsS "http://127.0.0.1:4280/v1/apps")"
echo "$APPS_JSON" | grep -q "\"$APP\"" || { echo "FAIL: app $APP not found after deploy: $APPS_JSON"; exit 1; }
MACHINES_JSON="$(curl -fsS "http://127.0.0.1:4280/v1/apps/$APP/machines")"
echo "$MACHINES_JSON" | grep -q "\"web-$PR_ENV\"" || { echo "FAIL: machine web-$PR_ENV not found: $MACHINES_JSON"; exit 1; }
echo "$MACHINES_JSON" | grep -q "\"chant-env\":\"$PR_ENV\"" || { echo "FAIL: machine does not carry the chant-env=$PR_ENV ownership marker: $MACHINES_JSON"; exit 1; }
echo "app + marked machine live after the opened event"

# ── 4b. PR closed → the teardown job must sweep the env ──────────────────────
echo "=== Running workflow: pull_request closed ($RUNNER) ==="
CLOSE_LOG="$WORK/close.log"
if ! run_workflow "$FIXTURE/events/pr-closed.json" "$CLOSE_LOG"; then
  echo "FAIL: the runner reported a job failure on the closed event"
  exit 1
fi
grep -q "TEARDOWN-OK $PR_ENV" "$CLOSE_LOG" || { echo "FAIL: teardown job did not run to completion"; exit 1; }
if grep -q "DEPLOY-OK" "$CLOSE_LOG"; then
  echo "FAIL: deploy job ran on the closed event — the action gate is broken"
  exit 1
fi

echo "=== Asserting $APP is gone from the emulator ==="
APPS_JSON="$(curl -fsS "http://127.0.0.1:4280/v1/apps")"
if echo "$APPS_JSON" | grep -q "\"$APP\""; then
  echo "FAIL: app $APP still present after the closed event: $APPS_JSON"
  exit 1
fi
echo "environment swept after the closed event"

echo "PASS: chant-declared preview workflow deployed on PR open and tore down on PR close, on a real runner against mudflaps"
