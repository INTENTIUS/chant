#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
  echo "Usage: $0 [workspace|npm|build-examples|e2e-k8s|e2e-aws|e2e-eks|e2e-all|all]"
  echo ""
  echo "  workspace       — Run workspace smoke tests (bun link), keep container up"
  echo "  npm             — Run npm install smoke tests (bun pm pack)"
  echo "  build-examples  — Build all root examples in Docker, copy artifacts out"
  echo "  e2e-aws         — Deploy AWS/GitLab examples (needs AWS + GitLab creds)"
  echo "  e2e-eks         — Deploy EKS example (needs AWS creds + domain)"
  echo "  e2e-all         — Run all E2E tests (Docker)"
  echo "  e2e-local-aws   — Run AWS E2E tests directly on host (no Docker)"
  echo "  e2e-local-eks   — Run EKS E2E tests directly on host (no Docker)"
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
  echo "Running codegen (prepack) for all lexicons..."
  for lex in aws azure gcp gitlab k8s flyway; do
    echo "  prepack lexicons/$lex"
    bun run --cwd "$PROJECT_DIR/lexicons/$lex" prepack
  done

  echo "Building npm smoke test image (tests run during build)..."
  docker build -f "$SCRIPT_DIR/Dockerfile.smoke-npm" -t chant-smoke-npm "$PROJECT_DIR"
  echo "npm smoke tests passed (ran during docker build)."
}

build_e2e_image() {
  echo "Running codegen (prepack) for all lexicons..."
  for lex in aws azure gcp gitlab k8s flyway; do
    echo "  prepack lexicons/$lex"
    bun run --cwd "$PROJECT_DIR/lexicons/$lex" prepack
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

run_e2e_all() {
  build_e2e_image
  echo "Running all E2E tests..."
  docker run --rm --platform linux/amd64 \
    -v "$HOME/.aws:/root/.aws:ro" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e GITLAB_TOKEN -e GITLAB_URL -e GITLAB_GROUP \
    -e EKS_DOMAIN \
    chant-smoke-e2e all
}

run_e2e_local() {
  local group="${1:-all}"
  echo "Running E2E tests locally (no Docker)..."
  bash "$SCRIPT_DIR/e2e-smoke.sh" "$group"
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
  build-examples)
    run_build_examples
    ;;
  e2e-aws)
    run_e2e_aws
    ;;
  e2e-eks)
    run_e2e_eks
    ;;
  e2e-all)
    run_e2e_all
    ;;
  e2e-local-aws)
    run_e2e_local aws
    ;;
  e2e-local-eks)
    run_e2e_local eks
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
