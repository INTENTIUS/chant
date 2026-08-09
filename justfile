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
#
# Two passes (chant #1133): every `generate` below completes before any
# `bundle` starts. `lexicons/*/` iterates alphabetically, and forgejo's
# bundle step reads github's `src/generated/` barrel — on a clean clone
# (forgejo needing both, github needing only its barrel not yet built)
# a single alphabetical pass runs forgejo's bundle before github's generate
# and dies. Collecting which lexicons still need bundling and running that
# as a second, later pass removes the ordering dependency entirely.
_ensure-gen:
    #!/usr/bin/env bash
    set -euo pipefail
    needs_bundle=""
    for lex in lexicons/*/; do
      grep -q '"generate"' "${lex}package.json" 2>/dev/null || continue
      needs=false
      # packages that import ./generated need the src barrel
      if grep -qE 'from "\./generated' "${lex}src/index.ts" 2>/dev/null \
         && [ ! -f "${lex}src/generated/index.ts" ]; then needs=true; fi
      # a lexicon whose source reads generated/operations.json (#1177's fifth
      # artifact) needs it too — an old checkout can have the barrel but
      # predate the artifact, which _ensure-gen's barrel-only check missed
      if [ -f "${lex}src/generated/index.ts" ] \
         && grep -rqls 'generated/operations.json' "${lex}src/api" "${lex}src/codegen" 2>/dev/null \
         && [ ! -f "${lex}src/generated/operations.json" ]; then needs=true; fi
      # import/audit load the bundled dist/meta.json; the OKF knowledge
      # bundle (#1060) is part of the same bundle output — an old checkout
      # can have meta.json but predate dist/okf/
      if grep -q '"bundle"' "${lex}package.json" 2>/dev/null \
         && { [ ! -f "${lex}dist/meta.json" ] || [ ! -f "${lex}dist/okf/index.md" ]; }; then needs=true; fi
      if [ "$needs" = true ]; then
        echo "gen: $(basename "$lex")"
        npm run --prefix "$lex" generate
        grep -q '"bundle"' "${lex}package.json" 2>/dev/null && needs_bundle="$needs_bundle $lex"
      fi
    done
    for lex in $needs_bundle; do
      echo "bundle: $(basename "$lex")"
      npm run --prefix "$lex" bundle
    done

# Force-rebuild every lexicon's test artifacts (generate + bundle).
# Two passes (chant #1133) — see _ensure-gen above for why: every lexicon's
# generate runs before any lexicon's bundle, so a consumer (forgejo) whose
# bundle step reads a producer's (github's) generated barrel never runs
# ahead of that producer, regardless of alphabetical directory order.
regen:
    #!/usr/bin/env bash
    set -euo pipefail
    for lex in lexicons/*/; do
      grep -q '"generate"' "${lex}package.json" 2>/dev/null || continue
      echo "gen: $(basename "$lex")"
      npm run --prefix "$lex" generate
    done
    for lex in lexicons/*/; do
      grep -q '"generate"' "${lex}package.json" 2>/dev/null || continue
      grep -q '"bundle"' "${lex}package.json" 2>/dev/null || continue
      echo "bundle: $(basename "$lex")"
      npm run --prefix "$lex" bundle
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

# chant #1045 Phase 2 — the sandboxed-run-vs-in-process-run differential.
# Same corpus, same on-demand-report shape as `fold-differential` above.
# Already part of `just test` too.
sandbox-differential: _ensure-gen
    npx vitest run examples/sandbox-differential.test.ts --reporter=verbose

# chant #1067 — the lexicon completeness contract, actually enforced. Runs
# each lexicon's own tsconfig.build.json build, then `chant dev check-lexicon`
# (all tier-1 checks, including intrinsic-foldability validation and "every
# shipped example builds"), gated against the tracked KNOWN_FAILURES
# allowlist in scripts/check-lexicons.ts. An untracked failure exits 1.
check-lexicons: _ensure-gen
    npx tsx scripts/check-lexicons.ts

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
check: build lint test check-lexicons

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

# Left-of-line proof capture (#1084): profile chant build --fold vs cdk synth on the matched pair, one measurement on both (on-demand, needs network for pinned installs; no cloud credentials)
leftness-capture:
    bash test/leftness/capture.sh

# Deploy the components-aws-e2e example against a local AWS emulator (Floci in Docker; on-demand, needs Docker + aws CLI)
components-aws-e2e:
    bash test/components-aws-e2e.sh

# AWS config-controller round-trip (#1208): apply -> observe -> drift -> reconcile -> rollback
# on the canonical mixed-substrate example, both substrates in one run
# (on-demand, needs Docker + aws CLI + kubectl)
aws-cc-e2e:
    bash test/aws-cc-e2e.sh

# GCP config-controller round-trip (#1211): apply -> observe -> drift -> remediate -> destroy
# on the canonical GCP estate via direct REST against floci-gcp
# (on-demand, needs Docker)
gcp-cc-e2e:
    bash test/gcp-cc-e2e.sh

# Azure property-level drift acceptance (#1213): clean apply quiet, hand-edited NSG rule
# surfaces, RG-orphan estate stays observed, emulator restart reads MISSING
# (floci-az in Docker; on-demand, needs Docker only)
azure-drift-e2e:
    bash test/azure-drift-e2e.sh

# Azure config-controller round-trip (#1214): apply -> observe -> drift -> reconcile -> rollback
# on the canonical mixed-substrate example — AKS backed by a real k3s, the k8s
# Service on it included (floci-az in Docker; on-demand, needs Docker + kubectl)
azure-cc-e2e:
    bash test/azure-cc-e2e.sh

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
    # Refuse to tag a commit CI has not proven green (#1255). This recipe
    # pushes `main` explicitly, so it also requires you to be on it.
    bash scripts/release-preflight.sh main
    # Bump from the HIGHEST version any workspace package is on, not core's.
    # `just release-lexicon` can push one lexicon ahead of core — k8s shipped
    # 0.36.0 while core sat at 0.34.1 — and deriving the next version from core
    # alone then rewrites that lexicon BACKWARDS. The publish step skips it as
    # already-published, so the repo is left permanently behind the registry
    # with no error anywhere. Flooring at the max makes the lockstep bump
    # monotonic for every package (#1255).
    current=$(jq -r .version packages/core/package.json)
    highest=$(jq -r .version packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json wardens/*/package.json | sort -V | tail -1)
    IFS='.' read -r major minor patch <<< "$highest"
    case "{{bump}}" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
      *) echo "Usage: just release [major|minor|patch]"; exit 1 ;;
    esac
    next="$major.$minor.$patch"
    if [ "$highest" != "$current" ]; then
      echo "Floor: $highest — a package is ahead of core ($current)"
    fi
    # Monotonic or bust. The floor above already guarantees this; the check is
    # here so that reverting to a core-only bump fails loudly instead of
    # rewriting a package backwards and going quiet at publish time.
    for f in packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json wardens/*/package.json; do
      have=$(jq -r .version "$f")
      if [ "$(printf '%s\n%s\n' "$have" "$next" | sort -V | tail -1)" != "$next" ]; then
        echo "refusing to release: $f is at $have, ahead of the computed $next" >&2
        exit 1
      fi
    done
    echo "Bumping $current → $next"
    # Bump .version everywhere, and keep the @intentius/* peer/optional
    # dependency ranges in lockstep (they were frozen at ^0.1.0, which breaks
    # clean installs — #411). packages/k8s-client is published alongside the
    # lexicons (#1074), so it bumps with them.
    for f in packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json wardens/*/package.json; do
      jq --arg v "$next" '
        .version = $v
        | if .peerDependencies then .peerDependencies |= with_entries(if (.key | startswith("@intentius/")) then .value = "^" + $v else . end) else . end
        | if .optionalDependencies then .optionalDependencies |= with_entries(if ((.key | startswith("@intentius/")) and .value != "*") then .value = "^" + $v else . end) else . end
      ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    done
    # Keep the committed lockfile's workspace entries in step with the bump —
    # without this every release leaves package-lock.json recording the
    # previous version for all 12 workspace packages (#1094).
    npm install --package-lock-only
    git add packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json wardens/*/package.json package-lock.json
    git commit -m "chant-v$next"
    git tag "chant-v$next"
    git push origin main "chant-v$next"
    echo "Released chant-v$next — publish workflow triggered (tag pattern chant-v*)"

# Bump a single lexicon version and tag (e.g. just release-lexicon docker patch)
release-lexicon name bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    # Refuse to tag a commit CI has not proven green (#1255). No branch is
    # required — this recipe pushes HEAD, wherever it is — but HEAD must be
    # pushed and its chant run must have concluded success.
    bash scripts/release-preflight.sh
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
    # Keep the @intentius/* peer ranges in lockstep, the way `just release`
    # has since #411 — ranges frozen at an old version break clean installs.
    # A single-lexicon patch does NOT move core, so the ranges track the
    # CURRENT core / github-lexicon versions rather than this lexicon's new
    # one (#1255). Pinning them to $next would demand a core that does not
    # exist.
    core=$(jq -r .version packages/core/package.json)
    github_lexicon=$(jq -r .version lexicons/github/package.json)
    jq --arg v "$next" --arg core "$core" --arg ghl "$github_lexicon" '
      .version = $v
      | if .peerDependencies["@intentius/chant"] then .peerDependencies["@intentius/chant"] = "^" + $core else . end
      | if .peerDependencies["@intentius/chant-lexicon-github"] then .peerDependencies["@intentius/chant-lexicon-github"] = "^" + $ghl else . end
    ' lexicons/{{name}}/package.json \
      > lexicons/{{name}}/package.json.tmp && mv lexicons/{{name}}/package.json.tmp lexicons/{{name}}/package.json
    # And keep the committed lockfile's entry for this package in step, the
    # same reason `just release` does it (#1094).
    npm install --package-lock-only
    git add lexicons/{{name}}/package.json package-lock.json
    git commit -m "lexicon-{{name}}: v$next"
    git tag "lexicon-{{name}}-v$next"
    git push origin HEAD "lexicon-{{name}}-v$next"
    echo "Released @intentius/chant-lexicon-{{name}} v$next — publish workflow triggered"

# Build Zed extension (WASM)
ext-zed-build:
    cd editors/zed && cargo build --release --target wasm32-wasip1
