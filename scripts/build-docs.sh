#!/usr/bin/env bash
set -euo pipefail

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

# 2. Generate + build AWS lexicon docs
echo "Building AWS lexicon docs..."
cd lexicons/aws
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/aws"
cp -r lexicons/aws/docs/dist/* "$SITE/lexicons/aws/"

# 3. Generate + build GitLab lexicon docs
echo "Building GitLab lexicon docs..."
cd lexicons/gitlab
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/gitlab"
cp -r lexicons/gitlab/docs/dist/* "$SITE/lexicons/gitlab/"

# 4. Generate + build K8s lexicon docs
echo "Building K8s lexicon docs..."
cd lexicons/k8s
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/k8s"
cp -r lexicons/k8s/docs/dist/* "$SITE/lexicons/k8s/"

# 5. Generate + build Flyway lexicon docs
echo "Building Flyway lexicon docs..."
cd lexicons/flyway
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/flyway"
cp -r lexicons/flyway/docs/dist/* "$SITE/lexicons/flyway/"

# 6. Generate + build Azure lexicon docs
echo "Building Azure lexicon docs..."
cd lexicons/azure
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/azure"
cp -r lexicons/azure/docs/dist/* "$SITE/lexicons/azure/"

# 7. Generate + build GCP lexicon docs
echo "Building GCP lexicon docs..."
cd lexicons/gcp
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/gcp"
cp -r lexicons/gcp/docs/dist/* "$SITE/lexicons/gcp/"

# 8. Generate + build Helm lexicon docs
echo "Building Helm lexicon docs..."
cd lexicons/helm
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/helm"
cp -r lexicons/helm/docs/dist/* "$SITE/lexicons/helm/"

# 9. Generate + build GitHub lexicon docs
echo "Building GitHub lexicon docs..."
cd lexicons/github
npm run prepack
npx tsx src/codegen/docs-cli.ts
cd docs && npm install && npm run build && cd ../../..
mkdir -p "$SITE/lexicons/github"
cp -r lexicons/github/docs/dist/* "$SITE/lexicons/github/"

echo "Unified docs built to $OUT/"
