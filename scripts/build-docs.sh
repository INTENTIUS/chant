#!/usr/bin/env bash
set -euo pipefail

OUT=".docs-dist"
rm -rf "$OUT"

# Main docs use base: '/chant', so nest output under chant/ so a
# plain static server (bunx serve) resolves paths correctly.
SITE="$OUT/chant"

# 1. Build main docs
echo "Building main docs..."
bun install --cwd docs
bun --cwd docs build
mkdir -p "$SITE"
cp -r docs/dist/* "$SITE/"

# 2. Generate + build AWS lexicon docs
echo "Building AWS lexicon docs..."
cd lexicons/aws
bun run prepack
bun run src/codegen/docs-cli.ts
cd docs && bun install && bun run build && cd ../../..
mkdir -p "$SITE/lexicons/aws"
cp -r lexicons/aws/docs/dist/* "$SITE/lexicons/aws/"

# 3. Generate + build GitLab lexicon docs
echo "Building GitLab lexicon docs..."
cd lexicons/gitlab
bun run prepack
bun run src/codegen/docs-cli.ts
cd docs && bun install && bun run build && cd ../../..
mkdir -p "$SITE/lexicons/gitlab"
cp -r lexicons/gitlab/docs/dist/* "$SITE/lexicons/gitlab/"

echo "Unified docs built to $OUT/ (serve at root, browse /chant/)"
