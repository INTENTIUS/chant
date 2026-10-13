#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
  echo "Usage: $0 [workspace|npm|npm-registry|sql-registry [version]|build-examples|smoke-aws|smoke-eks|smoke-gke|smoke-aks|smoke-all|all]"
  echo ""
  echo "BUILD VERIFICATION:"
  echo "  workspace       — Workspace smoke tests (Node.js)"
  echo "  npm             — npm install smoke tests (npm pack)"
  echo "  npm-registry    — Registry smoke tests (install from npmjs.com @latest)"
  echo "  sql-registry    — sql lexicon from the registry against its emulator, both dialects"
  echo "                    (version or dist-tag, default latest; SQL_SMOKE_DB names its database)"
  echo "  build-examples  — Build all examples in Docker"
  echo ""
  echo "DEPLOYMENT SMOKE TESTS (verify example npm scripts work in Docker):"
  echo "  smoke-eks       — EKS example"
  echo "  smoke-aks       — AKS example"
  echo "  smoke-gke       — GKE example"
  echo "  smoke-aws       — AWS/GitLab examples"
  echo "  smoke-all       — All deployment smoke tests"
  echo ""
  echo "  all             — Run workspace + npm smoke tests"
  exit 1
}

run_workspace() {
  echo "Building workspace smoke test image..."
  docker build -f "$SCRIPT_DIR/Dockerfile.smoke" -t chant-smoke-workspace "$PROJECT_DIR"

  echo "Running workspace smoke tests..."
  docker run --rm --name chant-smoke \
    -v "$HOME/.claude:/root/.claude" \
    -v "$HOME/.claude.json:/root/.claude.json" \
    chant-smoke-workspace
}

run_npm() {
  # The npm image tars each lexicon's local dist/, so prepack exactly the
  # lexicons it packs: the list Dockerfile.smoke-npm reads (#3096).
  local lexicons
  lexicons=$(<"$SCRIPT_DIR/smoke-npm-lexicons.txt")
  echo "Running codegen (prepack) for the lexicons the npm image packs..."
  for lex in $lexicons; do
    echo "  prepack lexicons/$lex"
    npm run --prefix "$PROJECT_DIR/lexicons/$lex" prepack
  done

  echo "Building npm smoke test image (tests run during build)..."
  docker build -f "$SCRIPT_DIR/Dockerfile.smoke-npm" -t chant-smoke-npm "$PROJECT_DIR"
  echo "npm smoke tests passed (ran during docker build)."
}

build_e2e_image() {
  # The list Dockerfile.smoke-e2e packs (#3096).
  local lexicons
  lexicons=$(<"$SCRIPT_DIR/smoke-e2e-lexicons.txt")
  echo "Running codegen (prepack) for the lexicons the e2e image packs..."
  for lex in $lexicons; do
    echo "  prepack lexicons/$lex"
    npm run --prefix "$PROJECT_DIR/lexicons/$lex" prepack
  done

  echo "Building E2E smoke test image..."
  docker build --platform linux/amd64 -f "$SCRIPT_DIR/Dockerfile.smoke-e2e" -t chant-smoke-e2e "$PROJECT_DIR"
}

run_e2e_aws() {
  build_e2e_image
  echo "Running AWS/GitLab E2E tests..."
  docker run --rm --platform linux/amd64 \
    -v "$HOME/.aws:/root/.aws:ro" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e GITLAB_TOKEN -e GITLAB_URL -e GITLAB_GROUP \
    chant-smoke-e2e aws
}

run_e2e_eks() {
  build_e2e_image
  echo "Running EKS E2E tests..."
  docker run --rm --platform linux/amd64 \
    -v "$HOME/.aws:/root/.aws:ro" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e EKS_DOMAIN \
    chant-smoke-e2e eks
}

run_e2e_gke() {
  build_e2e_image
  echo "Running GKE E2E tests..."
  docker run --rm --platform linux/amd64 \
    -v "$HOME/.config/gcloud:/root/.config/gcloud" \
    chant-smoke-e2e gke
}

run_e2e_aks() {
  build_e2e_image
  echo "Running AKS E2E tests..."
  docker run --rm --platform linux/amd64 \
    -v "$HOME/.azure:/root/.azure" \
    chant-smoke-e2e aks
}

run_e2e_all() {
  build_e2e_image
  echo "Running all E2E tests..."
  docker run --rm --platform linux/amd64 \
    -v "$HOME/.aws:/root/.aws:ro" \
    -v "$HOME/.config/gcloud:/root/.config/gcloud" \
    -v "$HOME/.azure:/root/.azure" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e GITLAB_TOKEN -e GITLAB_URL -e GITLAB_GROUP \
    -e EKS_DOMAIN \
    chant-smoke-e2e all
}

run_npm_registry() {
  echo "Running registry smoke tests (@latest)..."
  docker build \
    -f "$PROJECT_DIR/test/Dockerfile.smoke-npm-registry" \
    -t chant-smoke-npm-registry \
    "$PROJECT_DIR"
}

run_sql_registry() {
  # #3641: install chant and the sql lexicon from the registry, then build,
  # plan, apply and import against `chant emulator up --lexicon sql`. A
  # dist-tag is resolved here so the image's install layer is keyed on the
  # version it installs.
  local version="${1:-latest}"
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    version=$(npm view "@intentius/chant-lexicon-sql@$version" version)
  fi
  echo "Running sql registry smoke tests (@intentius/chant-lexicon-sql@$version)..."
  docker build \
    -f "$SCRIPT_DIR/Dockerfile.smoke-sql-registry" \
    --build-arg "CHANT_VERSION=$version" \
    -t chant-smoke-sql-registry \
    "$PROJECT_DIR"
  # The socket lets `chant emulator up` reach the host's daemon. The host
  # network lets its readiness probe reach the servers on localhost, where it
  # publishes them, and the test reach them at their bridge addresses.
  docker run --rm --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e SQL_SMOKE_DB -e SQL_SMOKE_CLICKHOUSE -e SQL_SMOKE_POSTGRES -e SQL_SMOKE_KEEP \
    chant-smoke-sql-registry
}

run_build_examples() {
  echo "Building smoke image..."
  docker build -f "$SCRIPT_DIR/Dockerfile.smoke" -t chant-smoke-workspace "$PROJECT_DIR"

  local output_dir="$PROJECT_DIR/test/example-builds"
  rm -rf "$output_dir"
  mkdir -p "$output_dir"

  echo "Building examples inside container (isolated)..."
  docker run --rm \
    -v "$output_dir:/output" \
    chant-smoke-workspace \
    bash /app/test/build-examples.sh

  echo ""
  echo "Artifacts written to test/example-builds/"
  ls -la "$output_dir"/*/
}

case "${1:-workspace}" in
  workspace)
    run_workspace
    ;;
  npm)
    run_npm
    ;;
  npm-registry)
    run_npm_registry
    ;;
  sql-registry)
    run_sql_registry "${2:-latest}"
    ;;
  build-examples)
    run_build_examples
    ;;
  smoke-aws)
    run_e2e_aws
    ;;
  smoke-eks)
    run_e2e_eks
    ;;
  smoke-gke)
    run_e2e_gke
    ;;
  smoke-aks)
    run_e2e_aks
    ;;
  smoke-all)
    run_e2e_all
    ;;
  all)
    run_workspace
    run_npm
    ;;
  *)
    usage
    ;;
esac

echo ""
echo "All smoke tests passed!"
