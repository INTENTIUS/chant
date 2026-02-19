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

# Build and run smoke test container (drops into bash at getting-started example)
smoke:
    docker build -f test/Dockerfile.smoke -t chant-smoke . && docker run -it --rm -v "$HOME/.claude:/root/.claude" -v "$HOME/.claude.json:/root/.claude.json" chant-smoke

# Build unified documentation site (main + lexicon docs)
docs-build:
    bash scripts/build-docs.sh

# Build and serve unified docs locally
docs-serve: docs-build
    bunx serve .docs-dist
