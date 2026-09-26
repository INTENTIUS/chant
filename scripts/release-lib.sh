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

# release_ship <tag> <merge-message> merges the tagged bump commit (the
# worktree's HEAD) into origin/main and pushes main and the tag together.
# If main moves meanwhile, the push is refused as a whole and this retries on
# the new main. Nothing is force-pushed.
release_ship() {
  local tag="$1" message="$2" bumped attempt f unmerged extra
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
    if git push --quiet --atomic origin "HEAD:refs/heads/main" "refs/tags/$tag"; then
      echo "Pushed $tag ($(git rev-parse --short "$bumped")) and main ($(git rev-parse --short HEAD))"
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
  git tag -d "$1" >/dev/null 2>&1 || true
  echo "release: $2" >&2
  echo "release: nothing was pushed; the local tag $1 is deleted." >&2
}
