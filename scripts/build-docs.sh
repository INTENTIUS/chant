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
# chant #1720 — this was thirteen copies of the same five lines, one per
# lexicon, and k3d and k3s were simply absent from it. Both have a complete
# docs/ tree; neither was ever built, so /chant/lexicons/k3d/ and
# /chant/lexicons/k3s/ 404 and lychee failed any page that linked to them.
#
# Deriving the list from the filesystem is the fix: a lexicon with a docs/
# directory is in the site, and a new one cannot be silently left out. The
# codegen step is conditional because a hand-written docs site (k3d, k3s) has
# no generated pages and therefore no src/codegen/docs-cli.ts.
for lex_dir in lexicons/*/; do
  lex="$(basename "$lex_dir")"
  [ -d "$lex_dir/docs" ] || continue

  echo "Building $lex lexicon docs..."
  (
    cd "$lex_dir"
    npm run prepack
    if [ -f src/codegen/docs-cli.ts ]; then
      npx tsx src/codegen/docs-cli.ts
    fi
    cd docs && npm install && npm run build
  )
  mkdir -p "$SITE/lexicons/$lex"
  cp -r "$lex_dir/docs/dist/"* "$SITE/lexicons/$lex/"
done

# Match GitHub Pages: redirect directory URLs to the trailing-slash form so
# relative links (e.g. ../composites/) resolve the same locally as in prod.
cat > "$OUT/serve.json" <<'JSON'
{
  "trailingSlash": true
}
JSON

echo "Unified docs built to $OUT/"
