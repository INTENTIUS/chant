#!/usr/bin/env bash
# The publish workflow's CI gate (chant #2817): instead of running the whole
# suite again, check that the `chant` workflow passed on the commit being
# released.
#
# `just release` and `just release-lexicon` tag a bump commit on top of a
# commit whose `chant` run succeeded (scripts/release-preflight.sh, #2816).
# When the commit under release changes nothing but version fields in
# package.json files (and package-lock.json), the run checked is its parent's,
# which has already passed. Any other commit, for example main's head on a
# workflow_dispatch, must have a green run itself.
#
# That run may still be queued or in progress when the tag lands: the recipe
# pushes main and the tag together, and that push is what starts `chant` on
# the bump commit. So the gate waits for the run instead of failing on it
# (#3027). It passes as soon as a run on the target succeeds and fails as
# soon as every run on it has completed without success.
#
# Usage: scripts/publish-verify-ci.sh [<commit>]    (default: HEAD)
# Needs: gh, authenticated (GH_TOKEN), jq, and the commit's parent fetched.
# Env:   GITHUB_REPOSITORY (default: INTENTIUS/chant)
#        PUBLISH_VERIFY_WAIT_SECONDS    how long to wait for a run to finish
#                                       (default 2700, 45 minutes)
#        PUBLISH_VERIFY_APPEAR_SECONDS  how long to wait for a run to exist at
#                                       all (default 300)
#        PUBLISH_VERIFY_POLL_SECONDS    between API calls (default 30)
#        PUBLISH_VERIFY_TARGET_ONLY=1 prints the commit whose run would be
#        checked and stops, without calling the API (for its test).
#
# Writes outcome=<passed|failed|missing|timeout> to $GITHUB_OUTPUT. publish.yml
# keeps the tag on `timeout` (CI was only slow; re-run the failed jobs once it
# is green) and deletes it on the others.
set -euo pipefail

repo="${GITHUB_REPOSITORY:-INTENTIUS/chant}"
commit=$(git rev-parse "${1:-HEAD}^{commit}")
wait_s="${PUBLISH_VERIFY_WAIT_SECONDS:-2700}"
appear_s="${PUBLISH_VERIFY_APPEAR_SECONDS:-300}"
poll_s="${PUBLISH_VERIFY_POLL_SECONDS:-30}"

# A package.json with the fields a release bump may move blanked out: the
# version, and every @intentius/* dependency range that is a version. Parsed
# as JSON, so a re-serialisation that changes nothing (jq writing "—"
# back as the character itself, chant-v0.99.0) does not count as an edit.
bump_normal() {
  jq -S '
    del(.version)
    | reduce ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies") as $k (.;
        if (.[$k] | type) == "object" then
          .[$k] |= with_entries(
            if (.key | startswith("@intentius/")) and ((.value | type) == "string") and (.value | test("^[\\^~]?[0-9]+\\.[0-9]+\\.[0-9]+"))
            then .value = "<version>" else . end)
        else . end)'
}

# True when <commit> only moves versions: every changed file is a workspace
# package.json or package-lock.json, and each changed package.json is the same
# JSON as before once its version and @intentius/* ranges are set aside.
only_a_bump() {
  local c="$1" files f before after
  git rev-parse --quiet --verify "$c^" >/dev/null || return 1
  files=$(git diff --name-only "$c^" "$c")
  [ -n "$files" ] || return 1
  if printf '%s\n' "$files" | grep -vqE '^((packages|lexicons)/[^/]+/package\.json|package-lock\.json)$'; then
    return 1
  fi
  for f in $files; do
    [ "$f" = package-lock.json ] && continue
    before=$(git show "$c^:$f" 2>/dev/null | bump_normal 2>/dev/null) || return 1
    after=$(git show "$c:$f" 2>/dev/null | bump_normal 2>/dev/null) || return 1
    [ "$before" = "$after" ] || return 1
  done
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

outcome() { # <passed|failed|missing|timeout>
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "outcome=$1" >> "$GITHUB_OUTPUT"; fi
}

start=$SECONDS
last=""
while :; do
  runs=$(gh api "repos/$repo/actions/workflows/chant.yml/runs?head_sha=$target&per_page=30" \
    --jq '.workflow_runs[] | "\(.id) \(.status) \(.conclusion // "-") \(.html_url)"')
  elapsed=$((SECONDS - start))
  if [ "$runs" != "$last" ]; then
    if [ -n "$runs" ]; then
      echo "chant runs for $target after ${elapsed}s:"
      printf '  %s\n' "$runs"
    fi
    last="$runs"
  fi

  green=$(printf '%s\n' "$runs" | awk '$2 == "completed" && $3 == "success" { print $4; exit }')
  if [ -n "$green" ]; then
    echo "chant passed on $target: $green"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "CI gate: chant passed on \`$target\` ($green)" >> "$GITHUB_STEP_SUMMARY"
    fi
    outcome passed
    exit 0
  fi

  if [ -z "$runs" ]; then
    if [ "$elapsed" -ge "$appear_s" ]; then
      echo "::error::no chant run found for $target after ${elapsed}s. Release a commit whose chant run passed, or run the suite on it first."
      outcome missing
      exit 1
    fi
  elif ! printf '%s\n' "$runs" | awk '$2 != "completed" { found = 1 } END { exit !found }'; then
    echo "::error::no chant run on $target concluded success (see above). Re-run it, then re-run this workflow."
    outcome failed
    exit 1
  fi

  if [ "$elapsed" -ge "$wait_s" ]; then
    echo "::error::chant is still running on $target after ${elapsed}s. The tag is kept: once that run is green, re-run this workflow's failed jobs (gh run rerun <id> --failed)."
    outcome timeout
    exit 1
  fi
  sleep "$poll_s"
done
