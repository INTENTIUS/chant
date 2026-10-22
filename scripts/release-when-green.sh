#!/usr/bin/env bash
# release-when-green.sh [major|minor|patch] [<sha>] [--dry-run] (#4218)
#
# Brings main's head, or <sha>, to ci/green/<sha> and cuts it with
# `just release`, then waits on the publish run and prints npm's `latest`:
#
#   1. starts each required ci.green phase that has no check run on the
#      commit: release-suites.yml (suites), chant.yml (check, test, validate)
#      when it takes a dispatch; a commit behind main's head goes through
#      `chant ci run --at <sha>` instead, since a dispatch on main builds the
#      head;
#   2. waits on the check runs and stops on the first one that fails, naming it;
#   3. once every phase passed and the commit has no green tag, starts the tick
#      (chant-ci-green.yml) and waits for the tag; a tick that finishes
#      without tagging stops it;
#   4. runs `just release <bump> <sha>` and waits on publish.yml at
#      release/npm/<version>.
#
# Only events end a wait: a run finishing, a job failing, a tag appearing.
# Nothing times out into a verdict. --dry-run says what it would start and
# runs `just release --dry-run` when the commit is already green; it never
# dispatches, tags or pushes.
#
# Test seams: RWG_POLL (seconds between polls, default 30), RWG_RELEASE_CMD
# (default `just release`), RWG_CHANT (default this checkout's CLI through tsx).
set -euo pipefail

bump=patch sha="" dry=0
for a in "$@"; do
  case "$a" in
    "") ;;
    major|minor|patch) bump="$a" ;;
    --dry-run|-n) dry=1 ;;
    -*) echo "release-when-green: unknown flag $a" >&2; exit 2 ;;
    *) sha="$a" ;;
  esac
done

poll="${RWG_POLL:-30}"
release_cmd="${RWG_RELEASE_CMD:-just release}"
chant="${RWG_CHANT:-npx tsx packages/core/src/cli/main.ts}"

say() { echo "release-when-green: $*"; }
die() { echo "release-when-green: $*" >&2; exit 1; }

git fetch --quiet origin main
head=$(git rev-parse origin/main)
sha=$(git rev-parse "${sha:-$head}^{commit}")
short=$(git rev-parse --short "$sha")
git merge-base --is-ancestor "$sha" origin/main || die "$short is not on origin/main"
released=$(git ls-remote origin 'refs/tags/release/npm/*' | awk -v s="$sha" '$1 == s { sub("refs/tags/release/npm/", "", $2); sub("\\^\\{\\}$", "", $2); print $2 }' | head -1)
[ -z "$released" ] || { say "$short is already released as $released"; exit 0; }

# The required phases and the check runs each needs, from the declaration on main.
decl=$(git show origin/main:chant.workspace.json)
phases=$(jq -r '.ci.green.require[]' <<<"$decl")
runs_of() { jq -r --arg p "$1" '.ci.green.phases[$p].runs[]' <<<"$decl"; }
# The workflow file holding each phase, for a dispatch on main.
workflow_of() {
  case "$1" in
    suites) echo release-suites.yml ;;
    *) echo chant.yml ;;
  esac
}
dispatchable() { git show "origin/main:.github/workflows/$1" 2>/dev/null | grep -q '^  workflow_dispatch'; }

green() { [ -n "$(git ls-remote origin "refs/tags/ci/green/$sha")" ]; }
check_runs() {
  gh api "repos/{owner}/{repo}/commits/$sha/check-runs?per_page=100" --paginate \
    -q '.check_runs[] | "\(.name)|\(.status)|\(.conclusion)"'
}
# A phase's state from the check runs: missing, pending, failed:<name> or passed.
phase_state() {
  local cr="$1" p="$2" run state="passed" line name status conclusion found
  while read -r run; do
    found=""
    while IFS='|' read -r name status conclusion; do
      # shellcheck disable=SC2053 # a run pattern may hold a glob
      [[ "$name" == $run ]] || continue
      found=1
      case "$status:$conclusion" in
        completed:success|completed:skipped|completed:neutral) ;;
        completed:*) echo "failed:$name ($conclusion)"; return ;;
        *) state=pending ;;
      esac
    done <<<"$cr"
    [ -n "$found" ] || { echo missing; return; }
  done < <(runs_of "$p")
  echo "$state"
}

# 1. Start what is missing.
cr=$(check_runs)
if green; then
  say "$short is already tagged ci/green"
else
  missing=()
  for p in $phases; do
    s=$(phase_state "$cr" "$p")
    case "$s" in
      failed:*) die "phase $p failed on $short: ${s#failed:}" ;;
      missing) missing+=("$p") ;;
    esac
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    if [ "$sha" != "$head" ]; then
      say "$short is behind main's head; requesting ${missing[*]} with chant ci run --at"
      [ "$dry" = 1 ] || $chant ci run --at "$sha"
    else
      started=()
      for p in "${missing[@]}"; do
        wf=$(workflow_of "$p")
        case " ${started[*]-} " in *" $wf "*) continue ;; esac
        dispatchable "$wf" || die "phase $p has no run on $short and $wf takes no workflow_dispatch, so it can't be started from here (#4216)"
        say "starting $wf on main for ${p}"
        [ "$dry" = 1 ] || gh workflow run "$wf" --ref main
        started+=("$wf")
      done
    fi
  fi
fi

if [ "$dry" = 1 ]; then
  if green; then
    $release_cmd "$bump" "$sha" --dry-run
  else
    say "dry run: would wait for the phases on $short, run the tick, then cut with: $release_cmd $bump $short"
  fi
  exit 0
fi

# 2 and 3. Wait for the phases, then the tick.
tick_started=""
while ! green; do
  cr=$(check_runs)
  all=1
  for p in $phases; do
    s=$(phase_state "$cr" "$p")
    case "$s" in
      failed:*) die "phase $p failed on $short: ${s#failed:}" ;;
      passed) ;;
      *) all=0 ;;
    esac
  done
  if [ "$all" = 1 ]; then
    if [ -z "$tick_started" ]; then
      say "every phase passed on $short; starting the tick"
      gh workflow run chant-ci-green.yml --ref main
      tick_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    else
      tick=$(gh run list -w chant-ci-green.yml -L 1 --json status,conclusion,createdAt \
        -q ".[] | select(.createdAt >= \"$tick_started\") | \"\(.status)|\(.conclusion)\"")
      case "$tick" in
        completed\|*) green || die "the tick finished ($tick) without tagging $short green" ;;
      esac
    fi
  fi
  green || sleep "$poll"
done
say "$short is tagged ci/green"

# 4. Cut and publish.
out=$($release_cmd "$bump" "$sha" | tee >(cat >&2))
version=$(sed -n 's/^Released \([^:]*\):.*/\1/p' <<<"$out")
[ -n "$version" ] || die "the release printed no version"
say "waiting on publish.yml at release/npm/$version"
while true; do
  run=$(gh run list -w publish.yml --branch "release/npm/$version" -L 1 --json databaseId,status,conclusion \
    -q '.[] | "\(.databaseId)|\(.status)|\(.conclusion)"')
  case "$run" in
    *\|completed\|success) break ;;
    *\|completed\|*) die "publish.yml for $version finished ${run##*|}: gh run view ${run%%|*}" ;;
  esac
  sleep "$poll"
done
say "published $version; npm latest is $(npm view @intentius/chant dist-tags.latest)"
