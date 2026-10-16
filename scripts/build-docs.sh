#!/usr/bin/env bash
# Build the docs site: core docs and every lexicon's docs, one Astro build.
#
#   bash scripts/build-docs.sh        # writes .docs-dist/chant/
#   DOCS_JOBS=4 bash scripts/build-docs.sh
#
# chant #3993: one Starlight site holds the core docs and every lexicon's.
# Each lexicon's docs pipeline (src/codegen/docs-cli.ts, which calls
# writeDocsSite in packages/core/src/codegen/docs.ts) runs in its in-site
# mode here: it writes the lexicon's pages to
# docs/src/content/docs/lexicons/<name>/ and a sidebar fragment beside them,
# and no Astro app of its own. Then one `astro build` of docs/ makes the site,
# its search index and llms-full.txt.
set -euo pipefail

OUT=".docs-dist"
# Nest under chant/ to match Astro's base: '/chant'.
# GitHub Pages serves project repos at /<repo>/, so upload-pages-artifact
# uses the parent directory. Local serve (npx serve .docs-dist) also works.
SITE="$OUT/chant"
rm -rf "$OUT"

JOBS="${DOCS_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)}"

# Prefix every line a step prints with its name, so parallel logs stay
# readable. Returns the step's own exit status, not sed's.
prefixed() {
  local name="$1"; shift
  "$@" 2>&1 | sed -u "s/^/[$name] /"
  return "${PIPESTATUS[0]}"
}

# 1. Work that does not depend on the lexicons starts now, in the background:
# the diagram SVGs (core and lexicon, into docs/public/) and the docs site's
# own dependencies.
prefixed diagrams bash scripts/build-diagrams.sh &
diagrams_pid=$!
prefixed docs-install npm install --prefix docs --prefer-offline --no-audit --no-fund &
install_pid=$!

# 2. Generate every lexicon's docs section, in parallel.
#
# chant #1720: the list is derived from the filesystem, so a lexicon with docs
# cannot be silently left out. A lexicon has docs when it ships
# src/codegen/docs-cli.ts (the init-lexicon scaffold writes one).
#
# A lexicon needs only `generate` and `bundle` before its docs, not the whole
# `prepack`. docsPipeline reads dist/manifest.json and dist/meta.json, which
# `bundle` writes (src/package-cli.ts), plus the lexicon's own src/ for rules
# and examples; `validate` only checks and writes nothing, and `build` is tsc
# writing .d.ts files into dist/, which nothing here reads.
#
# Lexicons run at once, except where one reads another's generated output.
# Run alone from a clean tree (no lexicon's src/generated or dist), each
# lexicon's generate, bundle and docs succeed and write the same pages as the
# serial build, with one exception: forgejo's bundle imports
# @intentius/chant-lexicon-github, whose src/index.ts imports its
# src/generated/, so forgejo runs after github in github's job. (gitlab's
# import of github, and aws <-> k8s, are tsc-time only: they mattered to the
# full prepack this replaced, not to these steps.) A lexicon named in AFTER
# runs in the job of the lexicon it follows; a lexicon not mentioned anywhere
# gets a job of its own, which is where a new one lands.
AFTER="forgejo:github"

lexicons_with_docs() {
  for d in lexicons/*/; do
    if [ -f "$d/src/codegen/docs-cli.ts" ]; then basename "$d"; fi
  done
}

# One job per line: a lexicon, followed by the ones that run after it.
jobs_list() {
  local all lex pair followers
  all="$(lexicons_with_docs)"
  for lex in $all; do
    case " $AFTER " in *" $lex:"*) continue ;; esac
    followers=""
    for pair in $AFTER; do
      if [ "${pair#*:}" = "$lex" ] && printf '%s\n' "$all" | grep -qx "${pair%%:*}"; then
        followers="$followers ${pair%%:*}"
      fi
    done
    echo "$lex$followers"
  done
}

generate_lexicon() {
  local lex="$1"
  (
    cd "lexicons/$lex" &&
      npm run -s generate &&
      npm run -s bundle &&
      CHANT_DOCS_MODE=in-site npx tsx src/codegen/docs-cli.ts
  )
}

run_job() {
  local lex
  for lex in "$@"; do
    prefixed "$lex" generate_lexicon "$lex" || { echo "[$lex] FAILED" >&2; return 1; }
  done
}
export -f prefixed generate_lexicon run_job

# The sections are build output and gitignored; clear them so a removed
# lexicon or page leaves nothing behind.
find docs/src/content/docs/lexicons -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +

echo "Generating lexicon docs with $JOBS jobs..."
start=$(date +%s)
if ! jobs_list | xargs -P "$JOBS" -L 1 bash -c 'run_job "$@"' _; then
  echo "Lexicon docs generation failed; see the [lexicon] lines above." >&2
  exit 1
fi
echo "Lexicon docs generated in $(( $(date +%s) - start ))s"

wait "$diagrams_pid" || { echo "build-diagrams.sh failed" >&2; exit 1; }
wait "$install_pid" || { echo "npm install --prefix docs failed" >&2; exit 1; }

# 3. One Astro build: core and lexicon pages, one search index, one
# llms-full.txt. `npm run build` also runs docs/scripts/check-rooms.mjs, which
# checks the home page's and the rooms' links into lexicon pages.
echo "Building docs..."
npm run --prefix docs build
mkdir -p "$SITE"
cp -r docs/dist/* "$SITE/"

# Match GitHub Pages: redirect directory URLs to the trailing-slash form so
# relative links (e.g. ../composites/) resolve the same locally as in prod.
cat > "$OUT/serve.json" <<'JSON'
{
  "trailingSlash": true
}
JSON

echo "Unified docs built to $OUT/"
