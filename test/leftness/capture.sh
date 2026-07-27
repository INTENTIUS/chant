#!/bin/bash
# Left-of-line capture (chant #1084): profile both tools producing their output with
# node --cpu-prof, then apply ONE measurement to both captures (analyze.mjs).
#
# Run from this directory: ./capture.sh   (or `just leftness-capture` from the repo root)
# Needs: node >= 22, network for the two pinned npm installs. No cloud credentials —
# both synths are offline. Deliberately sequential; nothing here is timing-sensitive
# because the measurement excludes timing by design.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"

echo "── install (pinned, committed lockfiles)"
(cd chant-app && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund)
(cd cdk-app && npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund)

mkdir -p captures results chant-app/out

echo "── capture: chant build --fold (single process, no sandbox — the fold IS the claim)"
# chant's published bin execs `npx tsx`; profiling that would profile npx. Invoke the
# real entry point directly under one profiled node process instead.
(cd chant-app && node --cpu-prof --cpu-prof-dir="$HERE/captures" --cpu-prof-name=chant-build.cpuprofile \
  --import tsx node_modules/@intentius/chant/src/cli/main.ts \
  build src --lexicon aws --fold -o out/template.json 2> "$HERE/results/chant-build.log")

echo "── assert: every chant-app file folded (the boolean's hard invariant, not sampled)"
FOLDS=$(grep -c '\[fold:fold\]' results/chant-build.log || true)
RUNS=$(grep -c '\[fold:run\]' results/chant-build.log || true)
echo "   fold=$FOLDS run=$RUNS"
if [ "$RUNS" != "0" ] || [ "$FOLDS" = "0" ]; then
  echo "FAIL: chant estate did not fully fold — the capture would not support the claim." >&2
  grep '\[fold:run\]' results/chant-build.log >&2 || true
  exit 1
fi

echo "── capture: cdk synth (profiles the APP subprocess via cdk.json, not the CLI)"
(cd cdk-app && npx cdk synth --no-version-reporting --no-path-metadata --no-asset-metadata --quiet > /dev/null)

echo "── analyze: one measurement, both captures"
node analyze.mjs

echo "── parity: the pair is still the same infrastructure"
node parity.mjs

echo "── sanitize: strip machine-local path prefixes from the committed captures"
node -e '
  const fs = require("fs");
  const here = process.cwd();
  for (const f of fs.readdirSync("captures")) {
    if (!f.endsWith(".cpuprofile")) continue;
    const p = "captures/" + f;
    let s = fs.readFileSync(p, "utf8");
    s = s.split("file://" + here).join("file:///leftness").split(here).join("/leftness");
    fs.writeFileSync(p, s);
  }
  console.log("   captures sanitized (paths rooted at /leftness)");
'
echo "done — captures/ + results/analysis.json updated"
