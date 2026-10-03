#!/usr/bin/env bash
# Spike (#3278), throwaway. From the repo root: bash spikes/pg-3278-parser/run.sh
# Builds each spike project directory folded and with --no-fold and compares
# the outputs byte for byte, then runs the round-trip / error-location checks
# and the shared-core tokenizer check. The corpus and libpg_query measurements
# need a scratch directory: see corpus/run-corpus.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cd "$here/project"
for d in src edge; do
  npx tsx ../../../packages/core/src/cli/main.ts build "$d" --verbose -o "$out/$d-fold.json" 2>&1 | grep '\[fold:' || true
  npx tsx ../../../packages/core/src/cli/main.ts build "$d" --no-fold -o "$out/$d-run.json" >/dev/null 2>&1
  if cmp -s "$out/$d-fold.json" "$out/$d-run.json"; then echo "$d: fold and run byte-identical"; else echo "$d: fold and run DIFFER"; fi
done
npx tsx ../../../packages/core/src/cli/main.ts build src -o "$out/example.json" >/dev/null 2>&1
cat "$out/example.json" "$out/postgres.sql"
cd "$here/../.."
npx tsx spikes/pg-3278-parser/check.ts
npx tsx spikes/pg-3278-parser/check-shared-core.ts
