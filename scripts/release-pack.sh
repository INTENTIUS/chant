#!/usr/bin/env bash
# Pack every chant npm package at a release's label, for `chant release
# publish` (#4040). release/chant.config.ts names the tarballs this writes.
#
#   bash scripts/release-pack.sh <version>
#
# A release cut with `chant release cut --at` makes no version-bump commit, so
# the package.json files at the release's commit carry an older version. This
# sets every package to <version> (release_apply_version), packs them in
# publish-packages.sh's dependency layers, copies each tarball to
# .release/packs/<dir with / as _>.tgz, and puts the package.json files and
# package-lock.json back. The publish refuses a checkout with changed files,
# and .release/ is ignored by git.
set -euo pipefail

version="${1:?usage: release-pack.sh <version>}"
cd "$(git rev-parse --show-toplevel)"
source scripts/release-lib.sh

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "release-pack: the working tree has changes; pack from a clean checkout of the release's commit" >&2
  exit 1
fi

bump_files=(packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json)
restore() { git checkout --quiet -- "${bump_files[@]}" package-lock.json; }
trap restore EXIT
release_apply_version "$version"
# Every contract floor names a released version or this one (#4480). The
# stamp above is what lets NEXT_RELEASE pass at the release's own label.
npx tsx scripts/release-floors.ts

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chant-release-pack.XXXXXX")
DRY_RUN=1 PACK_ALL=1 CHANT_PUBLISH_WORK="$work" bash scripts/publish-packages.sh

rm -rf .release/packs
mkdir -p .release/packs
missing=0
for dir in packages/*/ lexicons/*/; do
  dir="${dir%/}"
  [ -f "$dir/package.json" ] || continue
  [ "$(jq -r '.private // false' "$dir/package.json")" = "true" ] && continue
  slug="${dir//\//_}"
  tgz=$(find "$work/tgz/$slug" -maxdepth 1 -name '*.tgz' 2>/dev/null | head -1)
  if [ -z "$tgz" ]; then
    echo "release-pack: no tarball for $dir" >&2
    missing=1
    continue
  fi
  cp "$tgz" ".release/packs/$slug.tgz"
done
rm -rf "$work"
[ "$missing" = 0 ] || exit 1
echo "packed $(find .release/packs -name '*.tgz' | wc -l | tr -d ' ') packages at $version in .release/packs"
