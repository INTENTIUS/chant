#!/usr/bin/env bash
set -euo pipefail

OUT=".docs-dist"
rm -rf "$OUT"

# Nest under chant/ to match Astro's base: '/chant'.
# GitHub Pages serves project repos at /<repo>/, so upload-pages-artifact
# uses the parent directory. Local serve (bunx serve .docs-dist) also works.
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

# 4. Generate + build K8s lexicon docs
echo "Building K8s lexicon docs..."
cd lexicons/k8s
bun run prepack
bun run src/codegen/docs-cli.ts
cd docs && bun install && bun run build && cd ../../..
mkdir -p "$SITE/lexicons/k8s"
cp -r lexicons/k8s/docs/dist/* "$SITE/lexicons/k8s/"

# 5. Generate + build Flyway lexicon docs
echo "Building Flyway lexicon docs..."
cd lexicons/flyway
bun run prepack
bun run src/codegen/docs-cli.ts
cd docs && bun install && bun run build && cd ../../..
mkdir -p "$SITE/lexicons/flyway"
cp -r lexicons/flyway/docs/dist/* "$SITE/lexicons/flyway/"

echo "Unified docs built to $OUT/"
