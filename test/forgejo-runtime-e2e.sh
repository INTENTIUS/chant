#!/usr/bin/env bash
set -euo pipefail

# Forgejo runtime E2E: build a chant workflow and ACTUALLY RUN it in Docker.
#
# Unlike the post-synth checks (which prove the YAML is well-formed) and the
# smoke tests (which prove the package installs), this proves a Forgejo runner
# accepts and executes chant's generated `.forgejo/workflows/ci.yml` — the
# `runs-on` label the dialect maps to (`ubuntu-latest` -> `docker`), step
# ordering, and `needs:` ordering across jobs.
#
# Forgejo Actions run on the same engine as `act` (nektos/act); Forgejo's own
# runner is `forgejo-runner` / `act_runner`, whose `exec` subcommand runs a
# workflow locally without a server. This script uses whichever of
# `forgejo-runner`, `act_runner`, or `act` is on PATH.
#
# On-demand only — NOT part of the gating CI. It needs Docker + a runner tool
# and is inherently slower/flakier than unit tests. Run it yourself:
#
#   just forgejo-runtime-e2e        (or)   bash test/forgejo-runtime-e2e.sh
#
# Override the image the `docker` label maps to with FORGEJO_E2E_IMAGE.
#
# Exit codes: 0 pass or cleanly skipped (no Docker / no runner tool); non-zero
# on a real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT/test/forgejo-runtime-e2e"
IMAGE="${FORGEJO_E2E_IMAGE:-node:20-bookworm-slim}"

skip() { echo "SKIP: $1"; exit 0; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

# Pick a Forgejo-compatible runner. `exec` subcommand for the runners; bare for act.
RUNNER=""
RUNNER_KIND=""
for cand in forgejo-runner act_runner act; do
  if command -v "$cand" >/dev/null 2>&1; then
    RUNNER="$cand"
    [ "$cand" = "act" ] && RUNNER_KIND="act" || RUNNER_KIND="exec"
    break
  fi
done
[ -n "$RUNNER" ] || skip "no Forgejo runner found (install forgejo-runner, act_runner, or act)"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ── 1. Build the fixture workflow → .forgejo/workflows/ci.yml ────────────────
echo "=== Building fixture workflow ==="
npx tsx "$FIXTURE/build.ts" "$WORK"
echo "--- generated .forgejo/workflows/ci.yml ---"
cat "$WORK/.forgejo/workflows/ci.yml"
echo "-------------------------------------------"

# A runner expects a git repo at the root.
( cd "$WORK" && git init -q && git add -A && git -c user.email=e2e@chant -c user.name=chant commit -qm fixture )

# ── 2. Run the workflow with the Forgejo runner ──────────────────────────────
echo "=== Running workflow ($RUNNER, label docker -> $IMAGE) ==="
LOG="$WORK/run.log"
cd "$WORK"
case "$RUNNER_KIND" in
  exec) RUN=( "$RUNNER" exec -W .forgejo/workflows/ci.yml -P "docker=$IMAGE" ) ;;
  act)  RUN=( "$RUNNER" push -W .forgejo/workflows/ci.yml -P "docker=$IMAGE" ) ;;
esac
if ! "${RUN[@]}" 2>&1 | tee "$LOG"; then
  echo "FAIL: the runner reported a job failure"
  exit 1
fi

# ── 3. Assert both jobs ran, in order ────────────────────────────────────────
# `verify` needs `build`, so seeing both markers proves the runner honored the
# dialect's runner label, ran the steps, and respected the needs edge.
grep -q "BUILD-OK" "$LOG"  || { echo "FAIL: build job did not run its steps"; exit 1; }
grep -q "VERIFY-OK" "$LOG" || { echo "FAIL: verify job (needs: build) did not run"; exit 1; }

echo "PASS: chant-generated Forgejo workflow built and executed in Docker"
