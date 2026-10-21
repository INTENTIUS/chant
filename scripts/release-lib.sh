# shellcheck shell=bash disable=SC2034,SC2154  # sets globals for the recipe; bump_files comes from it
# Shared steps of `just release` and `just release-lexicon` (#2816). Sourced,
# not run. A release tags the newest green commit on main (see
# release-preflight.sh), not HEAD, so the recipes:
#
#   1. pick the commit (release_args + release-preflight.sh),
#   2. check it out in a throwaway worktree (release_open), leaving your
#      checkout alone,
#   3. bump and commit there, and tag that commit, which is what publish.yml
#      triggers on,
#   4. merge the tag back into main without rewriting either (release_ship).
#
# The recipe defines `apply_bump`, which rewrites the files in the array
# `bump_files` (relative to the current directory) and refreshes
# package-lock.json. release_ship calls it a second time on main's copies of
# those files, so main keeps every edit made since the green commit and gains
# only the version fields. That is also how the merge's conflicts resolve:
# HEAD has the old version on exactly those lines.

# release_args <args...> sets RELEASE_BUMP (major|minor|patch, default
# patch), RELEASE_COMMIT (empty = newest green) and RELEASE_DRY_RUN (0|1).
release_args() {
  RELEASE_BUMP="patch"
  RELEASE_COMMIT=""
  RELEASE_DRY_RUN=0
  local a
  for a in "$@"; do
    case "$a" in
      "") ;;
      major|minor|patch) RELEASE_BUMP="$a" ;;
      --dry-run|-n) RELEASE_DRY_RUN=1 ;;
      -*) echo "release: unknown flag $a" >&2; return 1 ;;
      *)
        if [ -n "$RELEASE_COMMIT" ]; then
          echo "release: two commits given ($RELEASE_COMMIT, $a)" >&2
          return 1
        fi
        RELEASE_COMMIT="$a"
        ;;
    esac
  done
}

# release_next <version> <bump> prints the bumped version.
release_next() {
  local major minor patch
  IFS='.' read -r major minor patch <<< "$1"
  case "$2" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) echo "release: bump must be major, minor or patch, not \"$2\"" >&2; return 1 ;;
  esac
  echo "$major.$minor.$patch"
}

# release_max <version...> prints the highest.
release_max() { printf '%s\n' "$@" | sort -V | tail -1; }

# release_version_at <rev> <file> prints .version of <file> at <rev>, or
# nothing when the file does not exist there.
release_version_at() {
  git show "$1:$2" 2>/dev/null | jq -r .version 2>/dev/null || true
}

# release_family_versions prints a JSON object mapping each publishable
# @intentius/* package name to its current .version in the tree (#3905), for
# pinning in-family dependency ranges.
release_family_versions() {
  local f
  for f in packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json; do
    jq -c '{(.name): .version}' "$f"
  done | jq -s 'add'
}

# release_open <sha> makes a detached worktree at <sha>, cds into it and
# removes it on exit. Sets RELEASE_SHA, RELEASE_MAIN (origin/main now) and
# RELEASE_WT.
release_open() {
  RELEASE_SHA="$1"
  git fetch --quiet --tags origin main
  RELEASE_MAIN=$(git rev-parse origin/main)
  RELEASE_WT=$(mktemp -d "${TMPDIR:-/tmp}/chant-release.XXXXXX")
  RELEASE_REPO=$(git rev-parse --show-toplevel)
  # Another git process may hold config.lock for a moment.
  local i
  for i in 1 2 3 4 5; do
    git worktree add --quiet --detach "$RELEASE_WT" "$RELEASE_SHA" 2>/dev/null && break
    [ "$i" = 5 ] && { echo "release: could not add a worktree at $RELEASE_WT" >&2; return 1; }
    sleep 1
  done
  trap 'cd "$RELEASE_REPO" && git worktree remove --force "$RELEASE_WT" >/dev/null 2>&1 || true' EXIT
  cd "$RELEASE_WT" || return 1
}

# release_tag_exists <tag>: locally or on origin.
release_tag_exists() {
  git rev-parse --verify --quiet "refs/tags/$1" >/dev/null \
    || [ -n "$(git ls-remote --tags origin "refs/tags/$1" 2>/dev/null)" ]
}

# release_reference_tag <version> prints the reference workspace's tag for a
# release (#2543): reference-workspace-v<major>.<minor> when the version is a
# minor or major release (patch 0), nothing for a patch release. The recipe
# tags the same bump commit as chant-v<version> and passes it to release_ship
# as an extra tag, so both reach origin together or not at all.
release_reference_tag() {
  local major minor patch
  IFS='.' read -r major minor patch <<< "$1"
  [ "$patch" = 0 ] && echo "reference-workspace-v$major.$minor" || true
}

# release_ship <tag> <merge-message> [<extra-tag>...] merges the tagged bump
# commit (the worktree's HEAD) into origin/main and pushes main and the tags
# together.
# If main moves meanwhile, the push is refused as a whole and this retries on
# the new main. Nothing is force-pushed.
release_ship() {
  local tag="$1" message="$2" bumped attempt f unmerged extra
  shift 2
  local extra_tags=("$@") push_refs=("refs/tags/$tag")
  for f in "${extra_tags[@]}"; do push_refs+=("refs/tags/$f"); done
  bumped=$(git rev-parse HEAD)
  for attempt in 1 2 3 4 5; do
    git fetch --quiet origin main
    local main
    main=$(git rev-parse origin/main)
    git checkout --quiet --detach "$main"
    if [ "$(git merge-base "$bumped" "$main")" = "$main" ]; then
      # main has not moved past the green commit: the bump fast-forwards.
      git checkout --quiet --detach "$bumped"
    else
      git merge --no-ff --no-commit "$bumped" >/dev/null 2>&1 || true
      unmerged=$(git diff --name-only --diff-filter=U)
      for f in $unmerged; do
        if ! printf '%s\n' "${bump_files[@]}" package-lock.json | grep -qxF "$f"; then
          git merge --abort
          release_unship "$tag" "merging $tag into main conflicts in $f, which the bump did not touch."
          return 1
        fi
      done
      # Start from main's copy of every bumped file and bump it again, so
      # main's own edits since the green commit survive and only the version
      # fields change.
      for f in "${bump_files[@]}" package-lock.json; do
        if ! git show "$main:$f" > "$f" 2>/dev/null; then
          git merge --abort
          release_unship "$tag" "$f is gone from main."
          return 1
        fi
      done
      apply_bump
      git add "${bump_files[@]}" package-lock.json
      extra=$(git diff --cached --name-only "$main" | grep -vxF -f <(printf '%s\n' "${bump_files[@]}" package-lock.json) || true)
      if [ -n "$extra" ]; then
        git merge --abort
        release_unship "$tag" "the merge of $tag would change more than versions on main: $(echo $extra)"
        return 1
      fi
      git commit --quiet --no-verify -m "$message"
    fi
    if git push --quiet --atomic origin "HEAD:refs/heads/main" "${push_refs[@]}"; then
      echo "Pushed $tag${extra_tags[*]:+ and ${extra_tags[*]}} ($(git rev-parse --short "$bumped")) and main ($(git rev-parse --short HEAD))"
      return 0
    fi
    echo "release: push refused (main moved?), retrying on the new main ($attempt/5)" >&2
  done
  release_unship "$tag" "could not push main and $tag after 5 attempts."
  return 1
}

# release_unship <tag> <reason>: nothing reached origin, so drop the local tag
# and the next run starts clean.
release_unship() {
  # extra_tags is release_ship's array, visible here through bash's dynamic scope.
  local t
  for t in "$1" "${extra_tags[@]}"; do git tag -d "$t" >/dev/null 2>&1 || true; done
  echo "release: $2" >&2
  echo "release: nothing was pushed; the local tag $1 is deleted." >&2
}

# release_apply_version <version> sets .version of every file in `bump_files`
# to <version>, with the @intentius/* dependency, peer and optional ranges at
# ^<version>, and refreshes package-lock.json, as `just release-legacy`'s
# apply_bump does. scripts/release-pack.sh runs it before packing (#4040).
release_apply_version() {
  local v="$1" f
  for f in "${bump_files[@]}"; do
    jq --arg v "$v" '
      .version = $v
      | if .peerDependencies then .peerDependencies |= with_entries(if (.key | startswith("@intentius/")) then .value = "^" + $v else . end) else . end
      | if .optionalDependencies then .optionalDependencies |= with_entries(if ((.key | startswith("@intentius/")) and .value != "*") then .value = "^" + $v else . end) else . end
      | if .dependencies then .dependencies |= with_entries(if (.key | startswith("@intentius/")) then .value = "^" + $v else . end) else . end
    ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  done
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null
}

# release_lexicon_floor <name> <rev> prints the highest version lexicons/<name>
# has anywhere (#4040): its package.json at <rev> and on main, its
# lexicon-<name>-v* tags, the release/npm/* tags (`just release` publishes
# every package at that label without moving package.json), and npm. So
# `just release-lexicon` never picks a version at or below one npm has. A
# package npm has never seen (E404) adds nothing; any other `npm view` failure
# refuses, since the floor would then be a guess.
release_lexicon_floor() {
  local name="$1" rev="$2" file="lexicons/$1/package.json" pkg out t
  local versions=("$(release_version_at "$rev" "$file")" "$(release_version_at "${RELEASE_MAIN:-origin/main}" "$file")")
  while read -r t; do [ -n "$t" ] && versions+=("${t#"lexicon-$name-v"}"); done < <(git tag -l "lexicon-$name-v*")
  while read -r t; do [ -n "$t" ] && versions+=("${t#release/npm/}"); done < <(git tag -l 'release/npm/*')
  pkg=$(git show "$rev:$file" | jq -r .name)
  if out=$(npm view "$pkg" version 2>&1); then
    versions+=("$(printf '%s' "$out" | tail -1 | tr -d '[:space:]')")
  elif ! printf '%s' "$out" | grep -q 'E404'; then
    echo "release: npm view $pkg version failed, so the version floor is unknown: $(printf '%s' "$out" | tail -1)" >&2
    return 1
  fi
  release_max "${versions[@]}"
}
