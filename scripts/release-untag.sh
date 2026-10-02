#!/usr/bin/env bash
# Delete the tag of a failed release, unless part of it already reached npm.
#
# Run by publish.yml's `untag` job, on the tagged commit, after the gate,
# the trusted-publisher audit or the publish failed.
#
# #1481: a tag should exist only for a release that reached npm, so when
# nothing published the tag goes and the tag list stays the truth.
#
# #3191: once some of the release's packages are on npm, deleting the tag is
# the worse mistake. chant-v0.81.0 (#2646) published 19 of 21 packages, then
# lost its tag, which left main and npm at 0.81.0 and git with no tag for it,
# and the recovery was recreating the tag by hand. So the tag is kept, the
# script lists what is on npm and what is not, and it exits 1 so the run
# says so. Fix the cause and `gh run rerun <id> --failed`; publish-packages.sh
# skips whatever is already on npm.
#
# The release's packages are the ones whose version the tagged commit moved
# (`just release` and `just release-lexicon` both tag a bump commit), and the
# registry is asked about each one, so a re-run or a publish cancelled
# halfway is judged by what npm actually holds. A package the registry gives no clear answer for counts as
# published: keeping a tag is recoverable, deleting one npm is ahead of is not.
#
# A version npm accepted a moment ago can still read as missing on the
# registry's read side, so PUBLISHED_IN_RUN, the publish job's own list of
# what it published (space-separated name@version), also counts as on npm.
#
# Needs the tagged commit and its parent (checkout fetch-depth: 2). The tag
# is GITHUB_REF_NAME.
set -uo pipefail

tag="${GITHUB_REF_NAME:?GITHUB_REF_NAME is not set}"

# "<name> <version>" for every non-private package the tagged commit moved.
# With no parent to compare against, every publishable package is a candidate,
# which can only err towards keeping the tag.
released() {
  local f old new name has_parent=1
  git rev-parse -q --verify HEAD^ >/dev/null 2>&1 || has_parent=0
  for f in packages/*/package.json lexicons/*/package.json; do
    [ -f "$f" ] || continue
    [ "$(jq -r '.private // false' "$f")" = "true" ] && continue
    name=$(jq -r '.name // empty' "$f")
    new=$(jq -r '.version // empty' "$f")
    [ -n "$name" ] && [ -n "$new" ] || continue
    if [ $has_parent -eq 1 ]; then
      old=$(git show "HEAD^:$f" 2>/dev/null | jq -r '.version // empty' 2>/dev/null)
      [ "$old" = "$new" ] && continue
    fi
    printf '%s %s\n' "$name" "$new"
  done
}

on_npm=()
not_on_npm=()
unclear=()

while read -r name version; do
  [ -n "$name" ] || continue
  case " ${PUBLISHED_IN_RUN:-} " in
    *" $name@$version "*) on_npm+=("$name@$version"); continue ;;
  esac
  out=$(npm view "$name@$version" version 2>&1)
  rc=$?
  if [ $rc -eq 0 ] && [ "$out" = "$version" ]; then
    on_npm+=("$name@$version")
  elif { [ $rc -eq 0 ] && [ -z "$out" ]; } || printf '%s' "$out" | grep -q 'E404'; then
    # npm 11 answers E404 both for a missing version and a missing package;
    # an empty answer is what older npm prints for a missing version.
    not_on_npm+=("$name@$version")
  else
    unclear+=("$name@$version")
  fi
done < <(released)

summary() {
  echo "### release ${tag}"
  echo
  printf '| package | npm |\n|---|---|\n'
  local e
  for e in "${on_npm[@]:-}";     do [ -n "$e" ] && printf '| `%s` | published |\n' "$e"; done
  for e in "${unclear[@]:-}";    do [ -n "$e" ] && printf '| `%s` | could not tell |\n' "$e"; done
  for e in "${not_on_npm[@]:-}"; do [ -n "$e" ] && printf '| `%s` | **not published** |\n' "$e"; done
  echo
}

summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "$GITHUB_STEP_SUMMARY"

if [ ${#on_npm[@]} -gt 0 ] || [ ${#unclear[@]} -gt 0 ]; then
  msg="release ${tag} is partly on npm (published: ${#on_npm[@]}, could not tell: ${#unclear[@]}, not published: ${#not_on_npm[@]}). Keeping the tag. Fix the cause, then re-run the failed jobs: the publish skips what is already on npm."
  echo "::error::$msg"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$msg" >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi

echo "::error::release ${tag} failed and none of its packages reached npm — deleting its tag"
git push origin ":refs/tags/${tag}"
