#!/usr/bin/env bash
# `just release` (#5137, design #5132 decisions 2, 4 and 6): cut a release
# train of chant's npm packages at the newest green main commit, or <commit>.
#
#   bash scripts/release-train.sh [major|minor|patch] [<member>=major|minor|patch ...] [<commit>] [--dry-run]
#
# Each publishable package is its own release member under release/
# (release/core, release/lexicon-aws, ...). The steps:
#
#   1. Fetch main, the ci/, release/, release-train/ and chant-v tags, and
#      chant/lifecycle; pick the commit with scripts/release-preflight.sh.
#   2. `chant release changed --at <sha>` in release/ lists the members to
#      release, with the dependency closure, in publish order. A bare level
#      bumps every member; <member>=<level> bumps one (default patch).
#   3. Each member's label is the bumped one, floored past every version the
#      package has anywhere (release_member_floor: its tags, the lockstep
#      tags, its ledger, npm). The first train, when release/ has none
#      recorded yet, cuts every member at one label one past the highest of
#      them all and of the lockstep member's ledger, so every member has a
#      release a train can pin.
#   4. When core is in the train, its floors must name released versions or
#      core's label (scripts/release-floors.ts --npm).
#   5. `chant release cut <label> --at <sha>` in each member's directory. The
#      cut pushes chant/lifecycle and tags release/npm/<member>/<label> locally.
#      A member that already has a release at <sha> (a run that stopped part
#      way) is not cut again.
#   6. `chant workspace train npm` in release/ records the train: these
#      members at their new labels, every other member at its newest release.
#      scripts/release-push-ledger.ts pushes the record.
#   7. One atomic push of each member's release/npm/<member>/<label> tag, the
#      release-train/npm/<train id> tag on <sha>, and the reference
#      workspace's tag when core's label is a minor or major. publish.yml
#      publishes the train from the release-train tag.
#
# --dry-run lists the members and labels and runs each cut without --yes,
# which cuts, records, tags and pushes nothing.
#
# Test seams: RELEASE_CHANT (the chant command), RELEASE_PREFLIGHT (default
# `bash scripts/release-preflight.sh`), RELEASE_FLOORS (default `npx tsx
# scripts/release-floors.ts`), RELEASE_PUSH_LEDGER (default `npx tsx
# scripts/release-push-ledger.ts`).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
source scripts/release-lib.sh

default="" commit="" dry=0
declare -A level=()
for a in "$@"; do
  case "$a" in
    "") ;;
    major|minor|patch)
      [ -z "$default" ] || { echo "release: two bumps given ($default, $a)" >&2; exit 2; }
      default="$a" ;;
    --dry-run|-n) dry=1 ;;
    -*) echo "release: unknown flag $a" >&2; exit 2 ;;
    *=*)
      m="${a%%=*}" l="${a#*=}"
      case "$l" in major|minor|patch) ;; *) echo "release: $a: the bump must be major, minor or patch" >&2; exit 2 ;; esac
      level[$m]="$l" ;;
    *)
      [ -z "$commit" ] || { echo "release: two commits given ($commit, $a)" >&2; exit 2; }
      commit="$a" ;;
  esac
done
default="${default:-patch}"

chant="${RELEASE_CHANT:-npx tsx $PWD/packages/core/src/cli/main.ts}"
export RELEASE_CHANT="$chant"
preflight="${RELEASE_PREFLIGHT:-bash scripts/release-preflight.sh}"
floors="${RELEASE_FLOORS:-npx tsx scripts/release-floors.ts}"
push_ledger="${RELEASE_PUSH_LEDGER:-npx tsx scripts/release-push-ledger.ts}"

# 1. The cut's trunk check reads origin/main as fetched (release-workstation.ts).
git fetch --quiet origin main
git fetch --quiet origin 'refs/tags/ci/*:refs/tags/ci/*' 'refs/tags/release/*:refs/tags/release/*' 'refs/tags/release-train/*:refs/tags/release-train/*' 'refs/tags/chant-v*:refs/tags/chant-v*'
# The ledger is read from the local chant/lifecycle, so bring it up to the
# remote's. A local branch with records the remote lacks is left as it is;
# the next cut's push replays it.
if git fetch --quiet origin chant/lifecycle:refs/remotes/origin/chant/lifecycle 2>/dev/null; then
  git fetch --quiet origin chant/lifecycle:chant/lifecycle 2>/dev/null \
    || echo "release: the local chant/lifecycle has records origin lacks; reading it as it is" >&2
fi
sha=$($preflight ${commit:+"$commit"})
short=$(git rev-parse --short "$sha")
done_tag=$(git tag --points-at "$sha" -l 'release-train/npm/*' | head -1)
if [ -n "$done_tag" ]; then
  echo "$short is already released as $done_tag"
  exit 0
fi

mapfile -t members < <(jq -r '.members[] | select(.kind == "chant") | .name' release/chant.workspace.json)
[ "${#members[@]}" -gt 0 ] || { echo "release: release/chant.workspace.json declares no chant member" >&2; exit 1; }
known=" ${members[*]} "
for m in "${!level[@]}"; do
  [[ "$known" == *" $m "* ]] || { echo "release: $m is not a release member under release/ (${members[*]})" >&2; exit 2; }
done
bump_of() { echo "${level[$1]:-$default}"; }

# The label of $1's newest release cut from $sha, or nothing.
released_at() {
  (cd "release/$1" && $chant release list --json 2>/dev/null) \
    | jq -r --arg s "$sha" '[.releases[]? | select(.commit == $s and .label != null)] | last | .label // empty' 2>/dev/null || true
}

first=0
trains=$(cd release && $chant workspace train list npm --json)
[ "$(jq '.trains | length' <<<"$trains")" = 0 ] && first=1

# 2 and 3. The members and their labels, in publish order.
plan=()   # "<member> <label> <why>"
if [ "$first" = 1 ]; then
  [ "${#level[@]}" = 0 ] || { echo "release: the first train cuts every member at one label; give one bump for all (just release minor)" >&2; exit 2; }
  # A first train that stopped part way already spent its label on some members.
  label=""
  for m in "${members[@]}"; do
    l=$(released_at "$m")
    [ -z "$l" ] || label=$(release_max ${label:+"$label"} "$l")
  done
  if [ -z "$label" ]; then
    versions=()
    for m in "${members[@]}"; do versions+=("$(release_member_floor "$m" "$sha")"); done
    # The lockstep member's labels are spent too (#1481).
    while read -r l; do [ -n "$l" ] && versions+=("$l"); done < <(cd release && $chant release list --json 2>/dev/null | jq -r '.releases[]?.label // empty' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true)
    label=$(release_next "$(release_max "${versions[@]}")" "$default")
  fi
  changed=$(cd release && $chant release changed --at "$sha" --json) || {
    echo "release: chant release changed failed: $(jq -r '.error.message // empty' <<<"$changed" 2>/dev/null)" >&2
    exit 1
  }
  # Publish order from release changed, which lists every member when none has a release.
  mapfile -t order < <(jq -r '.members[]?.member' <<<"$changed")
  for m in "${members[@]}"; do [[ " ${order[*]-} " == *" $m "* ]] || order+=("$m"); done
  for m in "${order[@]}"; do plan+=("$m $label first-train"); done
else
  flags=()
  for m in "${members[@]}"; do flags+=(--bump-member "$m=$(bump_of "$m")"); done
  changed=$(cd release && $chant release changed --at "$sha" "${flags[@]}" --json) || {
    echo "release: chant release changed failed: $(jq -r '.error.message // empty' <<<"$changed" 2>/dev/null)" >&2
    exit 1
  }
  while IFS=$'\t' read -r m next why; do
    [ -n "$m" ] || continue
    l=$(released_at "$m")
    if [ -z "$l" ]; then
      floor=$(release_member_floor "$m" "$sha")
      l=$(release_next "$floor" "$(bump_of "$m")")
      [ -z "$next" ] || l=$(release_max "$l" "$next")
    fi
    plan+=("$m $l $why")
  done < <(jq -r '.members[] | [.member, (.next // ""), (if .reason.member then "\(.reason.code) \(.reason.member)" else .reason.code end | gsub(" "; ":"))] | @tsv' <<<"$changed")
  # A run that stopped after cutting some members and before tagging the
  # train: they have no change since, so release changed leaves them out.
  for m in "${members[@]}"; do
    [[ " ${plan[*]-} " == *" $m "* ]] && continue
    l=$(released_at "$m")
    [ -z "$l" ] || plan+=("$m $l already:cut:at:this:commit")
  done
fi

if [ "${#plan[@]}" = 0 ]; then
  echo "Nothing to release at $short: no member changed since its last release."
  exit 0
fi

core_label=""
for p in "${plan[@]}"; do
  read -r m l _ <<<"$p"
  [ "$m" = core ] && core_label="$l"
done
rtag=""
[ -z "$core_label" ] || rtag=$(release_reference_tag "$core_label")

echo "Release train from $short ($(git log -1 --format=%s "$sha")):"
[ "$first" = 0 ] || echo "  the first train: every member at one label"
for p in "${plan[@]}"; do
  read -r m l why <<<"$p"
  printf '  %-24s %s  (%s)\n' "$m" "$l" "${why//:/ }"
done

# 4. Refuse a train whose core floors name a version that is neither released
# nor core's label (#4480): set NEXT_RELEASE on main first with
# `npx tsx scripts/release-floors.ts --set <version>`.
if [ -n "$core_label" ]; then
  $floors --npm --rev "$sha" --release "$core_label"
fi

# 5. Cut.
yes=()
[ "$dry" = 1 ] || yes=(--yes)
for p in "${plan[@]}"; do
  read -r m l _ <<<"$p"
  if [ -n "$(released_at "$m")" ]; then
    echo "release: $m already has $l at $short; not cut again"
    continue
  fi
  (cd "release/$m" && $chant release cut "$l" --at "$sha" "${yes[@]}")
done
if [ "$dry" = 1 ]; then
  echo "Dry run: nothing cut, recorded, tagged or pushed.${rtag:+ It would also tag $rtag.}"
  exit 0
fi

# 6. Record the train and push the record.
train=$(cd release && $chant workspace train npm --json | jq -r .id)
[ -n "$train" ] && [ "$train" != null ] || { echo "release: recording the train printed no id" >&2; exit 1; }
$push_ledger

# 7. Tags. chant never pushes a release tag; publish.yml runs on the train's.
refs=()
for p in "${plan[@]}"; do
  read -r m l _ <<<"$p"
  refs+=("refs/tags/release/npm/$m/$l")
done
ttag="release-train/npm/$train"
git tag "$ttag" "$sha"
refs+=("refs/tags/$ttag")
if [ -n "$rtag" ]; then
  git tag "$rtag" "$sha"
  refs+=("refs/tags/$rtag")
fi
git push --atomic origin "${refs[@]}"
echo "Released train $train (${#plan[@]} member(s)): publish.yml runs on $ttag"
