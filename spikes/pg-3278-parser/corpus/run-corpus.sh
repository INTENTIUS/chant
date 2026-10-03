#!/usr/bin/env bash
# Spike (#3278): coverage and libpg_query measurements. libpg-query is not a
# repo dependency, so the referee runs in a scratch directory outside the repo.
#   bash spikes/pg-3278-parser/corpus/run-corpus.sh <scratch-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
s="$1"; mkdir -p "$s"
[ -d "$s/pgsrc" ] || git clone --depth 1 --branch REL_18_6 --filter=blob:none --sparse https://github.com/postgres/postgres "$s/pgsrc"
(cd "$s/pgsrc" && git sparse-checkout set src/test/regress/sql src/test/regress/expected src/include/parser)
mkdir -p "$s/lpq"; cd "$s/lpq"
[ -f package.json ] || npm init -y >/dev/null
npm install --no-save libpg-query@18.1.5 pgsql-parser@18.2.8 pg@8 >/dev/null
cp "$here/extract.mjs" "$here/mutate.mjs" "$here/libpg-query-measure.mjs" "$here/../server/probe.mjs" .
node extract.mjs "$s/pgsrc/src/test/regress/sql" "$s/corpus.json"
node mutate.mjs "$s/corpus.json" "$s/mutants.json"
node libpg-query-measure.mjs "$s/corpus.json"
cd "$here/../../.."
npx tsx spikes/pg-3278-parser/corpus/coverage.ts "$s/corpus.json" --mutants "$s/mutants.json"
# The server probe (Docker, through the slot lock):
#   .docker-slot.sh pg-3278-parser -- node "$s/lpq/probe.mjs" <dir holding src.sql and edge.sql from run.sh's builds>
