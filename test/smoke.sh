#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
  echo "Usage: $0 [workspace|npm|build-examples|all]"
  echo ""
  echo "  workspace       — Run workspace smoke tests (bun link), keep container up"
  echo "  npm             — Run npm install smoke tests (bun pm pack)"
  echo "  build-examples  — Build all root examples in Docker, copy artifacts out"
  echo "  all             — Run all smoke tests"
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
