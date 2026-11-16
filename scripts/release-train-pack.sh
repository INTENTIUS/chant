#!/usr/bin/env bash
# Pack every member a release train cut at this checkout's commit (#5137,
# design #5132 decision 4), for `chant workspace train publish npm <train>`.
#
#   bash scripts/release-train-pack.sh <train id|digest>
#
# publish.yml's release-train job runs it on the commit a release-train/npm/<id>
# tag names. It reads the train from `chant workspace train list npm --json` in
# release/ and packs each member whose release commit is HEAD with
# `scripts/release-pack.sh <member> <label> --train <train>`, so each
# @intentius/* range is ^<that package's label in the train>. A member the
# train pins at an earlier commit is not packed: the train publish checks it
# is already on npm. Shared dependencies are prepacked once
# (RELEASE_PACK_PREPACKED). RELEASE_CHANT overrides the chant command.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

train="${1:?usage: release-train-pack.sh <train id|digest>}"
chant="${RELEASE_CHANT:-npx tsx $PWD/packages/core/src/cli/main.ts}"
head=$(git rev-parse HEAD)

trains=$(cd release && $chant workspace train list npm --json)
found=$(jq -c --arg t "$train" '[.trains[] | select(.id == $t or .trainDigest == $t)] | last' <<<"$trains")
if [ "$found" = null ]; then
  echo "release-train-pack: no release train $train for npm" >&2
  exit 1
fi

mapfile -t cut < <(jq -r --arg h "$head" '.members[] | select(.commit == $h) | "\(.member)\t\(.label // "")"' <<<"$found")
if [ "${#cut[@]}" -eq 0 ]; then
  echo "release-train-pack: train $train cut no member at $(git rev-parse --short HEAD), so there is nothing to pack here" >&2
  exit 1
fi

# .release/ is ignored by git, so the list leaves the checkout clean.
mkdir -p .release
done_file="$PWD/.release/prepacked"
: > "$done_file"
for line in "${cut[@]}"; do
  member="${line%%$'\t'*}" label="${line#*$'\t'}"
  if [ -z "$label" ]; then
    echo "release-train-pack: train $train pins $member at a release with no label, which has no version to publish" >&2
    exit 1
  fi
  RELEASE_PACK_PREPACKED="$done_file" bash scripts/release-pack.sh "$member" "$label" --train "$train"
done
echo "packed ${#cut[@]} member(s) of train $train"
