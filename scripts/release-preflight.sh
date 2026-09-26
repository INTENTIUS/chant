#!/usr/bin/env bash
# Choose the commit a release tags, and refuse one CI has not proven green
# (#1255, #2816).
#
# A release used to tag main's HEAD and required HEAD's own `chant` run to
# have succeeded. With merges every few minutes and a 15-minute run, HEAD is
# rarely green, so a release chased main round after round. Now a release
# tags the newest commit on main whose `chant` run succeeded (or the commit
# you name), and the release recipes merge the bump back into main.
#
# Usage: release-preflight.sh [<commit>]
#   No commit: the newest first-parent commit of origin/main whose latest
#   `chant` push run concluded success.
#   A commit: it must be on origin/main and its latest `chant` run must have
#   concluded success.
#
# Prints the chosen full SHA on stdout. Everything else goes to stderr.
#
# Emergency opt-out: CHANT_RELEASE_SKIP_PREFLIGHT=1 (releases the named
# commit, or origin/main's HEAD, without checking CI).
set -euo pipefail

wanted="${1:-}"

fail() {
  echo "" >&2
  echo "preflight: $1" >&2
  echo "" >&2
  echo "Set CHANT_RELEASE_SKIP_PREFLIGHT=1 to release anyway." >&2
  exit 1
}

short() { git rev-parse --short "$1"; }

git fetch --quiet origin main 2>/dev/null || fail "could not fetch origin/main."
main=$(git rev-parse origin/main 2>/dev/null) || fail "origin/main does not exist."

if [ -n "$wanted" ]; then
  sha=$(git rev-parse --verify --quiet "$wanted^{commit}") || fail "\"$wanted\" is not a commit here."
  # Anything off main would be merged into main by the release, unreviewed.
  git merge-base --is-ancestor "$sha" "$main" || fail "$(short "$sha") is not on origin/main."
fi

if [ "${CHANT_RELEASE_SKIP_PREFLIGHT:-}" = "1" ]; then
  sha="${sha:-$main}"
  echo "preflight: SKIPPED (CHANT_RELEASE_SKIP_PREFLIGHT=1) — releasing $(short "$sha") unverified" >&2
  echo "$sha"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  fail "gh is not installed, so CI status cannot be verified."
fi

# The `chant` workflow is the gate (build, lint, full suite, lexicon
# contract). docs/docs-check are not release-blocking. Newest run first, so
# the first entry per headSha is that commit's latest verdict (a re-run
# reuses its run).
runs=$(gh run list --workflow=chant.yml --branch main --event push --limit 200 \
         --json headSha,status,conclusion,url 2>/dev/null) \
  || fail "gh run list failed, so CI status cannot be verified."

verdict() { # <sha> -> "status conclusion url", or empty
  printf '%s' "$runs" | jq -r --arg s "$1" \
    'map(select(.headSha == $s)) | first // empty | "\(.status) \(.conclusion // "" | if . == "" then "-" else . end) \(.url)"'
}

if [ -n "$wanted" ]; then
  v=$(verdict "$sha")
  [ -n "$v" ] || fail "no chant CI run found on main for $(short "$sha")."
  read -r status conclusion url <<< "$v"
  [ "$status" = "completed" ] || fail "chant CI is still $status for $(short "$sha") — wait for it. $url"
  [ "$conclusion" = "success" ] || fail "chant CI concluded \"$conclusion\" for $(short "$sha"). $url"
  echo "preflight: $(short "$sha") is on main and green ✓ $url" >&2
  echo "$sha"
  exit 0
fi

# Walk main newest first. Only first-parent commits: they are what main
# actually was, and the ones CI ran on push.
skipped=0
for c in $(git rev-list --first-parent --max-count 200 "$main"); do
  v=$(verdict "$c")
  if [ -z "$v" ]; then
    echo "preflight: skip $(short "$c") — no chant run" >&2
  else
    read -r status conclusion url <<< "$v"
    if [ "$status" = "completed" ] && [ "$conclusion" = "success" ]; then
      [ "$skipped" -gt 0 ] && echo "preflight: $skipped newer commit(s) on main are not green; releasing an older one" >&2
      echo "preflight: $(short "$c") is the newest green commit on main ✓ $url" >&2
      echo "$c"
      exit 0
    fi
    if [ "$status" = "completed" ]; then
      echo "preflight: skip $(short "$c") — chant $conclusion" >&2
    else
      echo "preflight: skip $(short "$c") — chant $status" >&2
    fi
  fi
  skipped=$((skipped + 1))
done

fail "no green chant run among the last 200 commits on main."
