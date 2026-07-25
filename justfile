# Default recipe - list all available commands
default:
    @just --list

# Install all dependencies
install:
    npm install
    npm install --prefix docs

# Type check the project
build:
    npx tsc --noEmit -p packages/core/tsconfig.json

# Build any missing lexicon test artifacts (#923). The suite consumes each
# lexicon's `src/generated/` barrel (imported by the package) and `dist/meta.json`
# (loaded by import/audit); CI produces both via each lexicon's `prepack`, but a
# fresh clone has only `npm install`. Idempotent — a lexicon is (re)built only
# when its barrel or meta.json is missing, so repeat runs are a no-op. Use
# `just regen` to force a full rebuild.
_ensure-gen:
    #!/usr/bin/env bash
    set -euo pipefail
    for lex in lexicons/*/; do
      grep -q '"generate"' "${lex}package.json" 2>/dev/null || continue
      needs=false
      # packages that import ./generated need the src barrel
      if grep -qE 'from "\./generated' "${lex}src/index.ts" 2>/dev/null \
         && [ ! -f "${lex}src/generated/index.ts" ]; then needs=true; fi
      # import/audit load the bundled dist/meta.json
      if grep -q '"bundle"' "${lex}package.json" 2>/dev/null \
         && [ ! -f "${lex}dist/meta.json" ]; then needs=true; fi
      if [ "$needs" = true ]; then
        echo "gen: $(basename "$lex")"
        npm run --prefix "$lex" generate
        grep -q '"bundle"' "${lex}package.json" 2>/dev/null && npm run --prefix "$lex" bundle
      fi
    done

# Force-rebuild every lexicon's test artifacts (generate + bundle)
regen:
    #!/usr/bin/env bash
    set -euo pipefail
    for lex in lexicons/*/; do
      grep -q '"generate"' "${lex}package.json" 2>/dev/null || continue
      echo "gen: $(basename "$lex")"
      npm run --prefix "$lex" generate
      grep -q '"bundle"' "${lex}package.json" 2>/dev/null && npm run --prefix "$lex" bundle
    done

# Run tests (builds missing lexicon artifacts first — see _ensure-gen)
test: _ensure-gen
    npx vitest run

# chant #1025 — the fold-vs-run differential corpus, standalone with its
# per-source report (fold / run-fallback / drift). Already part of `just
# test`/CI's "Run tests" step (it's a normal vitest file, gated the same as
# everything else there) — this target is for running just the differential
# on demand and seeing its report without the rest of the suite's noise.
fold-differential: _ensure-gen
    npx vitest run examples/fold-differential.test.ts --reporter=verbose

# Scaffold a throwaway lexicon and verify it installs + typechecks (#749 guard).
# Catches core-API drift that would break `chant init lexicon`. Needs the network
# (npm install). On-demand; not part of gating `check`.
scaffold-check:
    #!/usr/bin/env bash
    set -euo pipefail
    name="_scaffold_check"
    trap 'rm -rf "lexicons/$name"; npm install >/dev/null 2>&1 || true' EXIT
    rm -rf "lexicons/$name"
    npx tsx packages/core/src/cli/main.ts init lexicon "$name" >/dev/null
    npm install >/dev/null
    npx tsc --noEmit -p "lexicons/$name/tsconfig.build.json"
    echo "scaffold-check: a fresh lexicon installs and typechecks ✓"

# Run linter
lint:
    npx eslint packages/

# Run all checks (build, lint, test)
check: build lint test

# Build diagram SVGs from .dot source files (requires graphviz)
diagrams:
    bash scripts/build-diagrams.sh

# Start chant docs dev server (builds diagrams first)
docs: diagrams
    npm --prefix docs run dev

# Start a lexicon docs dev server (e.g. just docs-lexicon aws)
docs-lexicon lexicon:
    just lexicons/{{lexicon}}/docs

# Run performance benchmarks
bench:
    npx vitest run bench

# Build and run workspace smoke test (drops into bash)
smoke-workspace:
    docker build -f test/Dockerfile.smoke -t chant-smoke-workspace . && docker run -it --rm chant-smoke-workspace

# Build and run npm tarball smoke test (all 9 lexicons)
smoke-npm:
    ./test/smoke.sh npm

# Build all root examples in Docker and extract artifacts to test/example-builds/
smoke-build-examples:
    ./test/smoke.sh build-examples

# Smoke test against published npm packages (run after just release — local only, never CI)
smoke-npm-registry:
    ./test/smoke.sh npm-registry

# Run a chant-generated GitLab pipeline in Docker (gitlab-ci-local; on-demand, needs Docker)
gitlab-runtime-e2e:
    bash test/gitlab-runtime-e2e.sh

# Run a chant-generated Forgejo workflow in Docker (forgejo-runner/act exec; on-demand, needs Docker)
forgejo-runtime-e2e:
    bash test/forgejo-runtime-e2e.sh

# Deploy the components-aws-e2e example against a local AWS emulator (Floci in Docker; on-demand, needs Docker + aws CLI)
components-aws-e2e:
    bash test/components-aws-e2e.sh

# Prove the adopt-alb-services GENERATED pipeline deploys multi-service across isolated jobs, with cross-stack outputs threaded as artifacts (Floci in Docker; on-demand, needs Docker + aws CLI)
adopt-alb-services-e2e:
    bash test/adopt-alb-services-e2e.sh

# Prove `chant carve emit --env` adopts a LIVE AWS resource into chant source against a real endpoint (Floci in Docker; on-demand, needs Docker + aws CLI). The offline --state path is unit-tested separately.
carve-emit-e2e:
    bash test/carve-emit-e2e.sh

# Run all smoke tests
smoke: smoke-workspace smoke-npm

# Build unified documentation site (main + lexicon docs, includes diagrams)
docs-build:
    bash scripts/build-docs.sh

# Build and serve unified docs locally
docs-serve: docs-build
    npx serve .docs-dist

# Check internal doc links across the unified site (requires lychee: brew install lychee)
docs-check-links: docs-build
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v lychee >/dev/null 2>&1; then
      echo "lychee not installed. Install with: brew install lychee" >&2
      exit 127
    fi
    lychee --offline --no-progress \
      --root-dir "$PWD/.docs-dist" \
      --exclude '\.(css|js|mjs|svg|png|jpe?g|ico|woff2?|map|json|xml|webp|avif|gif)$' \
      --exclude 'pagefind/' \
      '.docs-dist/chant/**/*.html'

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
    # Bump .version everywhere, and keep the @intentius/* peerDependencies ranges
    # in lockstep (they were frozen at ^0.1.0, which breaks clean installs — #411).
    for f in packages/core/package.json lexicons/*/package.json; do
      jq --arg v "$next" '
        .version = $v
        | if .peerDependencies["@intentius/chant"] then .peerDependencies["@intentius/chant"] = "^" + $v else . end
        | if .peerDependencies["@intentius/chant-lexicon-github"] then .peerDependencies["@intentius/chant-lexicon-github"] = "^" + $v else . end
      ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    done
    git add packages/core/package.json lexicons/*/package.json
    git commit -m "chant-v$next"
    git tag "chant-v$next"
    git push origin main "chant-v$next"
    echo "Released chant-v$next — publish workflow triggered (tag pattern chant-v*)"

# Bump a single lexicon version and tag (e.g. just release-lexicon docker patch)
release-lexicon name bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    current=$(jq -r .version lexicons/{{name}}/package.json)
    IFS='.' read -r major minor patch <<< "$current"
    case "{{bump}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "Usage: just release-lexicon <name> [major|minor|patch]"; exit 1 ;;
    esac
    next="$major.$minor.$patch"
    echo "Bumping @intentius/chant-lexicon-{{name}} $current → $next"
    jq --arg v "$next" '.version = $v' lexicons/{{name}}/package.json \
      > lexicons/{{name}}/package.json.tmp && mv lexicons/{{name}}/package.json.tmp lexicons/{{name}}/package.json
    git add lexicons/{{name}}/package.json
    git commit -m "lexicon-{{name}}: v$next"
    git tag "lexicon-{{name}}-v$next"
    git push origin HEAD "lexicon-{{name}}-v$next"
    echo "Released @intentius/chant-lexicon-{{name}} v$next — publish workflow triggered"

# Build Zed extension (WASM)
ext-zed-build:
    cd editors/zed && cargo build --release --target wasm32-wasip1
