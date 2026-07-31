#!/usr/bin/env bash
# Refuse to cut a release from a commit CI has not proven green (#1255).
#
# Both release recipes push the version-bump commit straight to main, which
# bypasses branch protection:
#
#   remote: Bypassed rule violations for refs/heads/main:
#   remote: - 3 of 3 required status checks are expected.
#
# So the commit a release tag points at is one CI never ran, and nothing
# verified the code being released was green either. `just release-lexicon`
# will happily tag and publish from a red or unpushed main.
#
# Usage: release-preflight.sh [required-branch]
#   With a branch argument, HEAD must be on it (the whole-repo release pushes
#   `main` explicitly, so releasing from anywhere else is a mistake).
#   Without one, any branch is allowed but must still be pushed and green.
#
# Emergency opt-out: CHANT_RELEASE_SKIP_PREFLIGHT=1
set -euo pipefail

required_branch="${1:-}"

if [ "${CHANT_RELEASE_SKIP_PREFLIGHT:-}" = "1" ]; then
  echo "preflight: SKIPPED (CHANT_RELEASE_SKIP_PREFLIGHT=1) — releasing unverified"
  exit 0
fi

fail() {
  echo "" >&2
  echo "preflight: $1" >&2
  echo "" >&2
  echo "Set CHANT_RELEASE_SKIP_PREFLIGHT=1 to release anyway." >&2
  exit 1
}

branch=$(git rev-parse --abbrev-ref HEAD)

if [ -n "$required_branch" ] && [ "$branch" != "$required_branch" ]; then
  fail "on branch \"$branch\", but this recipe pushes \"$required_branch\"."
fi

# A dirty tree means the tag would not describe what you tested. Untracked
# files are ignored — they are not part of the commit being released.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "preflight: uncommitted changes —" >&2
  git status --short --untracked-files=no >&2
  fail "commit or stash them before releasing."
fi

git fetch --quiet origin "$branch" 2>/dev/null || fail "could not fetch origin/$branch."

head=$(git rev-parse HEAD)
remote=$(git rev-parse "origin/$branch" 2>/dev/null) || fail "origin/$branch does not exist."

if [ "$head" != "$remote" ]; then
  fail "HEAD ($(git rev-parse --short HEAD)) is not origin/$branch ($(git rev-parse --short "$remote")) — push or pull first."
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "gh is not installed, so CI status cannot be verified."
fi

# The `chant` workflow is the gate (build, lint, full suite, lexicon
# contract). docs/docs-check are not release-blocking.
run=$(gh run list --commit "$head" --workflow=chant.yml --limit 1 \
        --json status,conclusion,url 2>/dev/null || echo "")

if [ -z "$run" ] || [ "$run" = "[]" ]; then
  fail "no chant CI run found for $(git rev-parse --short HEAD) — push it and let CI run."
fi

status=$(printf '%s' "$run" | jq -r '.[0].status')
conclusion=$(printf '%s' "$run" | jq -r '.[0].conclusion // ""')
url=$(printf '%s' "$run" | jq -r '.[0].url')

if [ "$status" != "completed" ]; then
  fail "chant CI is still $status for $(git rev-parse --short HEAD) — wait for it. $url"
fi

if [ "$conclusion" != "success" ]; then
  fail "chant CI concluded \"$conclusion\" for $(git rev-parse --short HEAD). $url"
fi

echo "preflight: $branch @ $(git rev-parse --short HEAD) is pushed and green ✓"
