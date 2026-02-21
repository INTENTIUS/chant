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

# Build and run Bun smoke test (drops into bash at getting-started example)
smoke-bun:
    docker build -f test/Dockerfile.smoke -t chant-smoke-bun . && docker run -it --rm -v "$HOME/.claude:/root/.claude" -v "$HOME/.claude.json:/root/.claude.json" chant-smoke-bun

# Build and run Node.js smoke test
smoke-node:
    docker build -f test/Dockerfile.smoke-node -t chant-smoke-node . && docker run -it --rm chant-smoke-node

# Run all smoke tests
smoke: smoke-bun smoke-node

# Build unified documentation site (main + lexicon docs)
docs-build:
    bash scripts/build-docs.sh

# Build and serve unified docs locally
docs-serve: docs-build
    bunx serve .docs-dist
