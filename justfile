# Default recipe - list all available commands
default:
    @just --list

# Install all dependencies
install:
    bun install
    bun install --cwd docs

# Type check the project
build:
    bun run tsc --noEmit

# Run tests
test:
    bun test

# Run linter
lint:
    bun run eslint packages/

# Run all checks (build, lint, test)
check: build lint test

# Start chant docs dev server
docs:
    bun --cwd docs dev

# Start a lexicon docs dev server (e.g. just docs-lexicon aws)
docs-lexicon lexicon:
    just lexicons/{{lexicon}}/docs

# Run performance benchmarks
bench:
    bun test bench

# Build and run Bun smoke test (drops into bash at lambda-function example)
smoke-bun:
    docker build -f test/Dockerfile.smoke -t chant-smoke-bun . && docker run -it --rm -v "$HOME/.claude:/root/.claude" -v "$HOME/.claude.json:/root/.claude.json" -v "$HOME/.aws:/root/.aws:ro" chant-smoke-bun

# Build and run Node.js smoke test
smoke-node:
    docker build -f test/Dockerfile.smoke-node -t chant-smoke-node . && docker run -it --rm -v "$HOME/.aws:/root/.aws:ro" chant-smoke-node

# Build all root examples in Docker and extract artifacts to test/example-builds/
smoke-build-examples:
    ./test/smoke.sh build-examples

# Run all smoke tests
smoke: smoke-bun smoke-node

# Build unified documentation site (main + lexicon docs)
docs-build:
    bash scripts/build-docs.sh

# Build and serve unified docs locally
docs-serve: docs-build
    bunx serve .docs-dist

# Build VS Code extension
ext-vscode-build:
    cd editors/vscode && npm install && npm run build

# Package VS Code extension (.vsix)
ext-vscode-package:
    cd editors/vscode && npm install && npm run build && npm run package

# Bump version, tag, and push to trigger npm publish (e.g. just release patch)
release bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    current=$(jq -r .version packages/core/package.json)
    IFS='.' read -r major minor patch <<< "$current"
    case "{{bump}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "Usage: just release [major|minor|patch]"; exit 1 ;;
    esac
    next="$major.$minor.$patch"
    echo "Bumping $current → $next"
    for f in packages/core/package.json lexicons/*/package.json; do
      jq --arg v "$next" '.version = $v' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    done
    git add packages/core/package.json lexicons/*/package.json
    git commit -m "v$next"
    git tag "v$next"
    git push origin main "v$next"
    echo "Released v$next — publish workflow triggered"

# Build Zed extension (WASM)
ext-zed-build:
    cd editors/zed && cargo build --release --target wasm32-wasip1
