#!/usr/bin/env bash
# Spike (#3196), throwaway. From the repo root: bash spike/sql-3196/run.sh
# Builds each spike project directory with fold on and with --no-fold and
# compares the outputs byte for byte, then runs the round-trip and
# error-location checks. To see the core change's effect, apply
# spike/sql-3196/core-fold-tag-entities.patch first (git apply), and revert after.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
cd "$here/project"
for d in src edge composite; do
  npx tsx ../../../packages/core/src/cli/main.ts build "$d" --verbose -o "$out/$d-fold.json" 2>&1 | grep '\[fold:' || true
  npx tsx ../../../packages/core/src/cli/main.ts build "$d" --no-fold -o "$out/$d-run.json" >/dev/null 2>&1
  if cmp -s "$out/$d-fold.json" "$out/$d-run.json"; then echo "$d: fold and run byte-identical"; else echo "$d: fold and run DIFFER"; diff "$out/$d-fold.json" "$out/$d-run.json" || true; fi
done
cat "$out/src-fold.json"
cd "$here/../.."
npx tsx spike/sql-3196/check.ts
