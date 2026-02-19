#!/usr/bin/env bash
set -euo pipefail

OUT=".docs-dist"
rm -rf "$OUT"

# 1. Build main docs
echo "Building main docs..."
bun install --cwd docs
bun --cwd docs build
cp -r docs/dist "$OUT"

# 2. Generate + build AWS lexicon docs
echo "Building AWS lexicon docs..."
cd lexicons/aws
bun run src/codegen/docs-cli.ts
cd docs && bun install && bun run build && cd ../../..
mkdir -p "$OUT/lexicons/aws"
cp -r lexicons/aws/docs/dist/* "$OUT/lexicons/aws/"

# 3. Generate + build GitLab lexicon docs
echo "Building GitLab lexicon docs..."
cd lexicons/gitlab
bun run src/codegen/docs-cli.ts
cd docs && bun install && bun run build && cd ../../..
mkdir -p "$OUT/lexicons/gitlab"
cp -r lexicons/gitlab/docs/dist/* "$OUT/lexicons/gitlab/"

echo "Unified docs built to $OUT/"
