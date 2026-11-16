#!/usr/bin/env bash
# Pack chant's npm packages at a lockstep release's label, for `chant release
# publish` (#4040):
#
#   bash scripts/release-pack.sh <version>
#
# Every package at <version> (release_apply_version), packed in
# publish-packages.sh's dependency layers. publish-legacy.yml's
# release-publish job runs it on a release/npm/<label> tag, to publish a
# lockstep release again until two release trains have published (#5137).
# A release train packs nothing here: `chant workspace train prepare` stamps
# each member and npm packs its directory when the train publishes (#5154).
#
# A release cut with `chant release cut --at` makes no version-bump commit, so
# the package.json files at the release's commit carry an older version. The
# package.json files (and package-lock.json) are put back after packing.
# The publish refuses a checkout with changed files, and .release/ is ignored
# by git.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
source scripts/release-lib.sh

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "release-pack: the working tree has changes; pack from a clean checkout of the release's commit" >&2
  exit 1
fi

version="${1:?usage: release-pack.sh <version>}"
bump_files=(packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json)
restore() { git checkout --quiet -- "${bump_files[@]}" package-lock.json; }
trap restore EXIT
release_apply_version "$version"
# Every contract floor names a released version or this one (#4480). The
# stamp above is what lets NEXT_RELEASE pass at the release's own label.
# --npm: a CI checkout may lack a tag the maintainer's checkout has (#4503),
# and npm is what says a version was published.
npx tsx scripts/release-floors.ts --npm

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
