#!/usr/bin/env bash
# Build every lexicon's artifacts the way its `prepack` does, with the slow
# half in parallel (chant #2817).
#
# Each lexicon's prepack is `generate && bundle && validate && build` (forgejo
# has no validate). Run one lexicon after another, as CI did, that took 4 to 5
# minutes in the check job and in each of the four test shards, and about 3 of
# those minutes were the per-lexicon `tsc` builds.
#
# Here every lexicon's `generate` runs first, one at a time: they write under
# the shared ~/.chant schema cache, and a consumer's later steps read a
# producer's generated barrel (forgejo's bundle reads github's, helm's build
# compiles k8s's generated source), so all of them go before any other step,
# as `just regen` orders them (#1133). The rest of each lexicon's prepack
# (bundle, validate, build) then runs with one lexicon per CPU. A build
# compiles the other lexicons it imports from their source, not their dist, so
# builds do not wait on each other.
#
# The steps run are the ones each lexicon's own prepack script names, in its
# order, so this cannot drift from what `npm publish` runs.
#
# Usage: scripts/ci-lexicon-artifacts.sh [jobs]   (default: nproc)
set -euo pipefail

cd "$(dirname "$0")/.."
jobs="${1:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}"
logs="$(mktemp -d)"

# The npm scripts a lexicon's prepack runs, in order: "generate bundle validate build".
prepack_steps() {
  node -e '
    const p = require(process.argv[1]);
    const prepack = (p.scripts && p.scripts.prepack) || "";
    const steps = prepack.split("&&").map((s) => s.trim().match(/^npm run ([\w:-]+)$/));
    if (steps.some((m) => !m)) { console.error(`${p.name}: prepack is not a chain of npm run steps: ${prepack}`); process.exit(1); }
    console.log(steps.map((m) => m[1]).join(" "));
  ' "$PWD/$1/package.json"
}

lexicons=()
for dir in lexicons/*/; do
  dir="${dir%/}"
  node -e 'process.exit(require(process.argv[1]).scripts?.prepack ? 0 : 1)' "$PWD/$dir/package.json" 2>/dev/null || continue
  lexicons+=("$dir")
done
echo "${#lexicons[@]} lexicons; generate one at a time, then the rest of each prepack with ${jobs} at once"

start=$(date +%s)
for dir in "${lexicons[@]}"; do
  steps=$(prepack_steps "$dir")
  if [[ " $steps " == *" generate "* ]]; then
    echo "::group::generate $(basename "$dir")"
    npm run --prefix "$dir" generate
    echo "::endgroup::"
  fi
done
echo "generate: $(( $(date +%s) - start ))s"

# One lexicon's remaining prepack steps, its output kept to print as a group.
rest_of_prepack() {
  local dir="$1" name steps step t0
  name=$(basename "$dir")
  t0=$(date +%s)
  steps=$(prepack_steps "$dir")
  {
    for step in $steps; do
      [ "$step" = generate ] && continue
      npm run --prefix "$dir" "$step" || { echo "FAILED: npm run --prefix $dir $step"; return 1; }
    done
  } > "$logs/$name.log" 2>&1 || { echo "$name" >> "$logs/failed"; }
  echo "$name $(( $(date +%s) - t0 ))s" >> "$logs/times"
}
export -f rest_of_prepack prepack_steps
export logs

start=$(date +%s)
printf '%s\n' "${lexicons[@]}" | xargs -P "$jobs" -I{} bash -c 'rest_of_prepack "$1"' _ {}
echo "bundle, validate, build: $(( $(date +%s) - start ))s"

for dir in "${lexicons[@]}"; do
  name=$(basename "$dir")
  echo "::group::prepack $name"
  cat "$logs/$name.log"
  echo "::endgroup::"
done
sort -k2 -n -r -t' ' "$logs/times" | sed 's/^/  /'

if [ -s "$logs/failed" ]; then
  while read -r name; do
    echo "::error::lexicon ${name}'s prepack failed; its output:"
    cat "$logs/$name.log"
  done < "$logs/failed"
  exit 1
fi
