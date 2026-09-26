#!/usr/bin/env bash
# The publish workflow's CI gate (chant #2817): instead of running the whole
# suite again, check that the `chant` workflow already passed on the commit
# being released.
#
# `just release` and `just release-lexicon` tag a bump commit on top of a
# commit whose `chant` run succeeded (scripts/release-preflight.sh, #2816).
# The bump commit has no run of its own, so when the commit under release
# changes nothing but version fields in package.json files (and
# package-lock.json), the run checked is its parent's. Any other commit, for
# example main's head on a workflow_dispatch, must have a green run itself.
#
# Usage: scripts/publish-verify-ci.sh [<commit>]    (default: HEAD)
# Needs: gh, authenticated (GH_TOKEN), and the commit's parent fetched.
# Env:   GITHUB_REPOSITORY (default: INTENTIUS/chant)
#        PUBLISH_VERIFY_TARGET_ONLY=1 prints the commit whose run would be
#        checked and stops, without calling the API (for its test).
set -euo pipefail

repo="${GITHUB_REPOSITORY:-INTENTIUS/chant}"
commit=$(git rev-parse "${1:-HEAD}^{commit}")

# True when <commit> only moves versions: every changed file is a workspace
# package.json or package-lock.json, and every changed line in the package.json
# files is a "version" field or an @intentius/* dependency range.
only_a_bump() {
  local c="$1" files lines
  git rev-parse --quiet --verify "$c^" >/dev/null || return 1
  files=$(git diff --name-only "$c^" "$c")
  [ -n "$files" ] || return 1
  if printf '%s\n' "$files" | grep -vqE '^((packages|lexicons)/[^/]+/package\.json|package-lock\.json)$'; then
    return 1
  fi
  lines=$(git diff -U0 "$c^" "$c" -- 'packages/*/package.json' 'lexicons/*/package.json' | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' || true)
  if printf '%s\n' "$lines" | grep -vE '^$' | grep -vqE '^[+-]\s*"(version|@intentius/[a-z0-9-]+)": "[\^~]?[0-9]+\.[0-9]+\.[0-9]+[^"]*",?$'; then
    return 1
  fi
  return 0
}

target="$commit"
if only_a_bump "$commit"; then
  target=$(git rev-parse "$commit^")
  echo "$(git rev-parse --short "$commit") only bumps versions; checking its parent $(git rev-parse --short "$target")"
fi

if [ "${PUBLISH_VERIFY_TARGET_ONLY:-}" = 1 ]; then
  echo "target $target"
  exit 0
fi

runs=$(gh api "repos/$repo/actions/workflows/chant.yml/runs?head_sha=$target&per_page=30" \
  --jq '.workflow_runs[] | "\(.id) \(.status) \(.conclusion // "-") \(.html_url)"')
if [ -z "$runs" ]; then
  echo "::error::no chant run found for $target. Release a commit whose chant run passed, or run the suite on it first."
  exit 1
fi
echo "chant runs for $target:"
printf '  %s\n' "$runs"

green=$(printf '%s\n' "$runs" | awk '$2 == "completed" && $3 == "success" { print $4; exit }')
if [ -z "$green" ]; then
  echo "::error::no chant run on $target concluded success (see above). Wait for it, or re-run it, then re-run this workflow."
  exit 1
fi
echo "chant passed on $target: $green"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "CI gate: chant passed on \`$target\` ($green)" >> "$GITHUB_STEP_SUMMARY"
fi
