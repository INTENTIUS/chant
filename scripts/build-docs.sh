#!/usr/bin/env bash
set -euo pipefail

# Generate diagram SVGs from .dot source files before any Astro build runs.
bash scripts/build-diagrams.sh

OUT=".docs-dist"
rm -rf "$OUT"

# Nest under chant/ to match Astro's base: '/chant'.
# GitHub Pages serves project repos at /<repo>/, so upload-pages-artifact
# uses the parent directory. Local serve (npx serve .docs-dist) also works.
SITE="$OUT/chant"

# 1. Build main docs
echo "Building main docs..."
npm install --prefix docs
npm run --prefix docs build
mkdir -p "$SITE"
cp -r docs/dist/* "$SITE/"

# 2. Generate + build every lexicon's docs site.
#
# chant #1720 — this was one hardcoded cd/prepack/build/cp block per lexicon,
# thirteen of them, and k3d and k3s were simply not among them. Both ship a
# complete docs/ tree; neither was ever built, so /chant/lexicons/k3d/ and
# /chant/lexicons/k3s/ 404 on the published site and lychee failed any page
# that linked to them.
#
# The list is derived from the filesystem so a lexicon with docs cannot be
# silently left out. ORDER is not alphabetical and not decorative: a lexicon's
# `prepack` can import another's generated surface — forgejo and gitlab are
# github dialects and both import `lexicons/github/src/generated` — so github
# has to be generated first or their prepack dies with ERR_MODULE_NOT_FOUND.
# The dependency graph has cycles (aws <-> k8s, k8s <-> temporal), so this is a
# known-good order rather than a topological sort. Anything with docs and no
# entry here is appended, which is the case a new lexicon lands in.
ORDER="aws gitlab k8s azure gcp fly fountain helm github docker forgejo cedar temporal"

lexicons_with_docs() {
  for d in lexicons/*/; do
    [ -d "$d/docs" ] && basename "$d"
  done
}

build_order() {
  local all known
  all="$(lexicons_with_docs)"
  for lex in $ORDER; do
    printf '%s
' "$all" | grep -qx "$lex" && echo "$lex"
  done
  # Everything with docs that ORDER does not mention, in directory order.
  known=" $ORDER "
  printf '%s
' "$all" | while read -r lex; do
    case "$known" in *" $lex "*) ;; *) echo "$lex" ;; esac
  done
}

for lex in $(build_order); do
  echo "Building $lex lexicon docs..."
  (
    cd "lexicons/$lex"
    npm run prepack
    # A hand-written docs site (k3d, k3s) has no generated pages, and so no
    # codegen entry point — which is why neither could simply be appended to
    # the old hardcoded list.
    if [ -f src/codegen/docs-cli.ts ]; then
      npx tsx src/codegen/docs-cli.ts
    fi
    cd docs && npm install && npm run build
  )
  mkdir -p "$SITE/lexicons/$lex"
  cp -r "lexicons/$lex/docs/dist/"* "$SITE/lexicons/$lex/"
done

# Match GitHub Pages: redirect directory URLs to the trailing-slash form so
# relative links (e.g. ../composites/) resolve the same locally as in prod.
cat > "$OUT/serve.json" <<'JSON'
{
  "trailingSlash": true
}
JSON

echo "Unified docs built to $OUT/"
