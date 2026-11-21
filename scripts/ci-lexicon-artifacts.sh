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
# order, so this cannot drift from what `npm publish` runs. A lexicon with
# floors runs its build under `tsx ../../scripts/release-floors.ts --lexicon
# <name> --pack npm run build`, which writes its floors as the versions they
# ship with for the build; that is its `build` step, and it runs here the same
# way.
#
# --steps limits the run to some of those steps (#3793). chant.yml builds
# what the unit tests and typechecks read (`--steps generate,bundle`: the
# generated barrels and dist/meta.json) once, in one job, and caches it; its
# validate job restores that and runs `--steps validate,build`. With no
# --steps, every step runs, as `npm publish` would.
#
# Usage: scripts/ci-lexicon-artifacts.sh [--steps <step,...>] [jobs]   (default: nproc)
set -euo pipefail

cd "$(dirname "$0")/.."
only=""
if [ "${1:-}" = "--steps" ]; then
  only=",${2:?--steps needs a comma-separated list, such as generate,bundle},"
  shift 2
fi
jobs="${1:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}"
logs="$(mktemp -d)"
export only

# Whether --steps (if given) includes this step.
wanted() { [ -z "$only" ] || [[ "$only" == *",$1,"* ]]; }

# The npm scripts a lexicon's prepack runs, in order: "generate bundle validate build".
# A step run under release-floors' pack for this lexicon prints as "floors:<step>".
prepack_steps() {
  node -e '
    const p = require(process.argv[1]);
    const lexicon = process.argv[2];
    const prepack = (p.scripts && p.scripts.prepack) || "";
    const wrapped = new RegExp(`^tsx \\.\\./\\.\\./scripts/release-floors\\.ts --lexicon ${lexicon} --pack npm run ([\\w:-]+)$`);
    const steps = prepack.split("&&").map((s) => {
      const t = s.trim();
      const plain = t.match(/^npm run ([\w:-]+)$/);
      if (plain) return plain[1];
      const floors = t.match(wrapped);
      return floors ? `floors:${floors[1]}` : null;
    });
    if (steps.some((s) => !s)) { console.error(`${p.name}: prepack is not a chain of npm run steps: ${prepack}`); process.exit(1); }
    console.log(steps.join(" "));
  ' "$PWD/$1/package.json" "$(basename "$1")"
}

# Run one prepack step in a lexicon: `npm run <step>`, or for "floors:<step>"
# the same under release-floors' pack, as the lexicon's prepack runs it.
run_step() {
  local dir="$1" step="$2"
  if [[ "$step" == floors:* ]]; then
    (cd "$dir" && npx tsx ../../scripts/release-floors.ts --lexicon "$(basename "$dir")" --pack npm run "${step#floors:}")
  else
    npm run --prefix "$dir" "$step"
  fi
}

lexicons=()
for dir in lexicons/*/; do
  dir="${dir%/}"
  node -e 'process.exit(require(process.argv[1]).scripts?.prepack ? 0 : 1)' "$PWD/$dir/package.json" 2>/dev/null || continue
  lexicons+=("$dir")
done
echo "${#lexicons[@]} lexicons; generate one at a time, then the rest of each prepack with ${jobs} at once${only:+ (steps:${only//,/ })}"

start=$(date +%s)
for dir in "${lexicons[@]}"; do
  wanted generate || break
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
      [ "${step#floors:}" = generate ] && continue
      wanted "${step#floors:}" || continue
      run_step "$dir" "$step" || { echo "FAILED: $step in $dir"; return 1; }
    done
  } > "$logs/$name.log" 2>&1 || { echo "$name" >> "$logs/failed"; }
  echo "$name $(( $(date +%s) - t0 ))s" >> "$logs/times"
}
export -f rest_of_prepack prepack_steps run_step wanted
export logs

start=$(date +%s)
printf '%s\n' "${lexicons[@]}" | xargs -P "$jobs" -I{} bash -c 'rest_of_prepack "$1"' _ {}
echo "the rest of each prepack: $(( $(date +%s) - start ))s"

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
