#!/usr/bin/env bash
set -euo pipefail

# GitLab runtime E2E: build a chant pipeline and ACTUALLY RUN it in Docker.
#
# Unlike the post-synth checks (which prove the YAML is well-formed) and the
# smoke tests (which prove the package installs), this proves GitLab CI accepts
# and executes chant's generated `.gitlab-ci.yml` — image pull, scripts,
# artifacts passed between jobs, and `needs:` ordering — using `gitlab-ci-local`
# (a maintained local pipeline runner). `gitlab-runner exec` is intentionally
# NOT used: it was removed in gitlab-runner 16.0.
#
# On-demand only — NOT part of the gating CI. It needs Docker + network and is
# inherently slower/flakier than unit tests. Run it yourself:
#
#   just gitlab-runtime-e2e        (or)   bash test/gitlab-runtime-e2e.sh
#
# Exit codes: 0 pass or cleanly skipped (no Docker); non-zero on real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT/test/gitlab-runtime-e2e"

skip() { echo "SKIP: $1"; exit 0; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ── 1. Build the fixture pipeline → .gitlab-ci.yml ───────────────────────────
echo "=== Building fixture pipeline ==="
npx tsx "$FIXTURE/build.ts" "$WORK"
echo "--- generated .gitlab-ci.yml ---"
cat "$WORK/.gitlab-ci.yml"
echo "--------------------------------"

# ── 2. Run the pipeline in Docker via gitlab-ci-local ────────────────────────
echo "=== Running pipeline (gitlab-ci-local) ==="
cd "$WORK"
LOG="$WORK/run.log"
if ! npx --yes gitlab-ci-local@4 --no-color 2>&1 | tee "$LOG"; then
  echo "FAIL: gitlab-ci-local reported a job failure"
  exit 1
fi

# ── 3. Assert both jobs ran and the artifact crossed the needs edge ──────────
# gitlab-ci-local prints a per-job summary; a passing run shows each job's
# script finishing. The `verify` job greps the artifact written by `build`, so
# its success alone proves the artifact was passed across the `needs:` edge.
if ! grep -Eq "verify.*finished|finished.*verify|verify.*pass" "$LOG"; then
  # Fall back to the explicit script echo to be runner-version tolerant.
  grep -q "built by chant" "$LOG" || { echo "FAIL: could not confirm the verify job ran"; exit 1; }
fi

echo "PASS: chant-generated pipeline built and executed in Docker"
