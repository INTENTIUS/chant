# Default recipe - list all available commands
default:
    @just --list

# Install all dependencies
install:
    npm install
    npm install --prefix docs

# Type check the project
build:
    scripts/tsc7.sh --noEmit --declaration false --declarationMap false -p packages/core/tsconfig.json

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

# Run the unit tests, the vitest `unit` project that pull request CI shards
# (builds missing lexicon artifacts first — see _ensure-gen). The end-to-end
# project is `just test-e2e`.
test: _ensure-gen
    npx vitest run --project unit

# The end-to-end tests, the vitest `e2e` project (*.e2e.test.ts). A large
# suite: it asks a person to type `run` (scripts/human-gate.sh). On GitHub
# release-suites.yml runs it when a person dispatches it. No release waits
# on it since CI went unit-only (2026-10-23).
test-e2e:
    @scripts/human-gate.sh test-e2e
    @just _ensure-gen
    npx vitest run --project e2e

# The e2e files a change reaches, run before it merges (#4217): changed e2e
# files, e2e files beside a changed file, what vitest's import graph relates to
# the diff, and the three example gates when the diff touches an example, a
# lexicon serializer or the docs. Not behind the human gate: this is the check
# a person or an agent runs on their own change. `--no-related` skips the
# import graph; `--list` prints the files without running them.
test-e2e-affected base="origin/main" *args: _ensure-gen
    npx tsx scripts/test-e2e-affected.ts {{base}} {{args}}

# chant #1025 — the fold-vs-run differential corpus, standalone with its
# per-source report (fold / run-fallback / drift). Part of the e2e project
# (`just test-e2e`, and release-suites.yml by hand) since #3793; this
# target runs just the differential on demand and shows its report without
# the rest of the suite's noise.
fold-differential: _ensure-gen
    npx vitest run examples/fold-differential.e2e.test.ts --reporter=verbose

# chant #1045 Phase 2 — the sandboxed-run-vs-in-process-run differential.
# Same corpus, same on-demand-report shape as `fold-differential` above.
# Also part of the e2e project.
sandbox-differential: _ensure-gen
    npx vitest run examples/sandbox-differential.e2e.test.ts --reporter=verbose

# chant #5118 — the pull request preset replay. Reruns chant audit, per-file
# chant lint and chant helm localize over a saved corpus of merged changes,
# on both sides of each, and fails when the preset's merge-blocking findings
# miss the bar in test/pr-preset-replay/score.ts. On demand; the corpus lives
# outside the repo. `work` keeps the per-commit reports between runs.
replay-pr-preset corpus work="" *args: _ensure-gen
    npx tsx test/pr-preset-replay/replay.ts --corpus {{corpus}} {{ if work != "" { "--work " + work } else { "" } }} {{args}}

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
    scripts/tsc7.sh --noEmit --declaration false --declarationMap false -p "lexicons/$name/tsconfig.build.json"
    echo "scaffold-check: a fresh lexicon installs and typechecks ✓"

# Which pinned dogwood surfaces has upstream moved? (#1688) Reads
# dogwood-policy/dogwood's current main over the GitHub API and diffs the blob
# hashes in lexicons/cedar/src/dogwood/upstream.ts against it. Needs the network;
# set GITHUB_TOKEN to avoid the anonymous rate limit. Advisory and never gating:
# exits 0 whatever it finds, nonzero only when the check itself cannot run. Per
# #808 the pin moves when a consuming test needs the newer upstream.
dogwood-freshness:
    npx tsx scripts/check-dogwood-freshness.ts

# The repo-wide typecheck (tests, scripts, examples) against
# scripts/typecheck-baseline.json, which can only shrink (#5187). Reads the
# generated lexicon files, so it builds missing ones first.
typecheck: _ensure-gen
    npx tsx scripts/typecheck.ts

# Run linter
lint:
    npx eslint packages/

# The fast local gate: core's typecheck, the repo-wide typecheck, lint, the unit tests and the lexicon
# contract. A change merges on this. The large suites (test-e2e, smoke*,
# *-e2e, helm-survey, bench) are not part of it and run only when a person
# starts them.
check: build typecheck lint test check-lexicons

# Build diagram SVGs from .dot source files (requires graphviz)
diagrams:
    bash scripts/build-diagrams.sh

# Start chant docs dev server (builds diagrams first)
docs: diagrams
    npm --prefix docs run dev

# Generate one lexicon's docs into the main site and start its dev server (e.g. just docs-lexicon aws)
docs-lexicon lexicon:
    just lexicons/{{lexicon}}/docs

# Run performance benchmarks
bench:
    @scripts/human-gate.sh bench
    npx vitest run bench

# Build and run workspace smoke test (drops into bash)
smoke-workspace:
    @scripts/human-gate.sh smoke-workspace
    docker build -f test/Dockerfile.smoke -t chant-smoke-workspace . && docker run -it --rm chant-smoke-workspace

# Build and run npm tarball smoke test (the lexicons in test/smoke-npm-lexicons.txt)
smoke-npm:
    @scripts/human-gate.sh smoke-npm
    ./test/smoke.sh npm

# Build all root examples in Docker and extract artifacts to test/example-builds/
smoke-build-examples:
    @scripts/human-gate.sh smoke-build-examples
    ./test/smoke.sh build-examples

# Smoke test against published npm packages (run after just release — local only, never CI)
smoke-npm-registry:
    @scripts/human-gate.sh smoke-npm-registry
    ./test/smoke.sh npm-registry

# sql lexicon from the registry against `chant emulator up --lexicon sql`, both dialects (#3641; local only, needs Docker). version: a version or dist-tag; SQL_SMOKE_DB names the database and schema it drops and recreates
smoke-sql-registry version="latest":
    @scripts/human-gate.sh smoke-sql-registry
    ./test/smoke.sh sql-registry {{version}}

# Run a chant-generated GitLab pipeline in Docker (gitlab-ci-local; on-demand, needs Docker)
gitlab-runtime-e2e:
    @scripts/human-gate.sh gitlab-runtime-e2e
    bash test/gitlab-runtime-e2e.sh

# Run a chant-generated Forgejo workflow in Docker (forgejo-runner/act exec; on-demand, needs Docker)
forgejo-runtime-e2e:
    @scripts/human-gate.sh forgejo-runtime-e2e
    bash test/forgejo-runtime-e2e.sh

# The fan-out demo (#4091): one cycle of examples/fan-out-estate/demo on its local Forgejo and floci (on-demand, needs Docker; run `cmd=up` once first). cmd: up, cycle, loop, reset, claim (the e2e harness's plain and BREAK runs, #4587) or down
fan-out-demo cmd="cycle":
    @scripts/human-gate.sh fan-out-demo
    cd examples/fan-out-estate && npm run demo -- {{cmd}}

# Per-PR preview loop (#1223) on a real runner: deploy on PR open, teardown on PR close, against mudflaps (on-demand, needs Docker + network)
forgejo-preview-e2e:
    @scripts/human-gate.sh forgejo-preview-e2e
    bash test/forgejo-preview-e2e.sh

# Left-of-line proof capture (#1084): profile chant build --fold vs cdk synth on the matched pair, one measurement on both (on-demand, needs network for pinned installs; no cloud credentials)
leftness-capture:
    @scripts/human-gate.sh leftness-capture
    bash test/leftness/capture.sh

# Run the "From zero to a promoted release" tutorial against a local AWS emulator (Floci in Docker; on-demand, needs Docker + aws CLI)
trunk-curated-floci-e2e:
    @scripts/human-gate.sh trunk-curated-floci-e2e
    bash test/trunk-curated-floci-e2e.sh

# Adopt a workspace of four Terraform roots into choudoufu in waves, canary first, one gate per root (chant#4461; Floci in Docker; on-demand, needs Docker, the aws CLI, node, OpenTofu and choudoufu)
workspace-promote-waves-floci-e2e:
    @scripts/human-gate.sh workspace-promote-waves-floci-e2e
    bash test/workspace-promote-waves-floci-e2e.sh

# Deploy the components-aws-e2e example against a local AWS emulator (Floci in Docker; on-demand, needs Docker + aws CLI)
components-aws-e2e:
    @scripts/human-gate.sh components-aws-e2e
    bash test/components-aws-e2e.sh

# AWS config-controller round-trip (#1208): apply -> observe -> drift -> reconcile -> rollback
# on the canonical mixed-substrate example, both substrates in one run
# (on-demand, needs Docker + aws CLI + kubectl)
aws-cc-e2e:
    @scripts/human-gate.sh aws-cc-e2e
    bash test/aws-cc-e2e.sh

# GCP config-controller round-trip (#1211): apply -> observe -> drift -> remediate -> destroy
# on the canonical GCP estate via direct REST against floci-gcp
# (on-demand, needs Docker)
gcp-cc-e2e:
    @scripts/human-gate.sh gcp-cc-e2e
    bash test/gcp-cc-e2e.sh

# Azure property-level drift acceptance (#1213): clean apply quiet, hand-edited NSG rule
# surfaces, RG-orphan estate stays observed, emulator restart reads MISSING
# (floci-az in Docker; on-demand, needs Docker only)
azure-drift-e2e:
    @scripts/human-gate.sh azure-drift-e2e
    bash test/azure-drift-e2e.sh

# Azure config-controller round-trip (#1214): apply -> observe -> drift -> reconcile -> rollback
# on the canonical mixed-substrate example — AKS backed by a real k3s, the k8s
# Service on it included (floci-az in Docker; on-demand, needs Docker + kubectl)
azure-cc-e2e:
    @scripts/human-gate.sh azure-cc-e2e
    bash test/azure-cc-e2e.sh

# AWS stack-level env teardown (#1222): deploy two envs + a foreign stack, tear one env
# down, assert only that env's marker-verified stack is deleted
# (Floci in Docker; on-demand, needs Docker only)
aws-teardown-e2e:
    @scripts/human-gate.sh aws-teardown-e2e
    bash test/aws-teardown-e2e.sh

# Worked example for the @intentius/chant/testing live-stack harness (#1224):
# deployStack into a nonce'd test env on Floci, assert output + live stack,
# destroy in afterAll — including the teardown-survives-a-failing-test fixture
# (Floci in Docker; on-demand, needs Docker only)
testing-harness-e2e:
    @scripts/human-gate.sh testing-harness-e2e
    CHANT_HARNESS_E2E=1 npx vitest run examples/testing-harness-aws/harness.e2e.test.ts

# Pinnability survey over the upstream chart corpus (#1228 Phase 0): pull each
# pinned chart, render twice with closed inputs, assert every verdict against
# expected.txt (a person starts it, here or by dispatching helm-survey.yml — needs helm 4 + network)
helm-survey:
    @scripts/human-gate.sh helm-survey
    CHANT_HELM_SURVEY=1 CHANT_UNIT_TEST_BUDGET_MS=0 npx vitest run lexicons/helm/test/survey/survey.test.ts

# Prove the adopt-alb-services GENERATED pipeline deploys multi-service across isolated jobs, with cross-stack outputs threaded as artifacts (Floci in Docker; on-demand, needs Docker + aws CLI)
adopt-alb-services-e2e:
    @scripts/human-gate.sh adopt-alb-services-e2e
    bash test/adopt-alb-services-e2e.sh

# Prove `chant carve emit --env` adopts a LIVE AWS resource into chant source against a real endpoint (Floci in Docker; on-demand, needs Docker + aws CLI). The offline --state path is unit-tested separately.
carve-emit-e2e:
    @scripts/human-gate.sh carve-emit-e2e
    bash test/carve-emit-e2e.sh

# Drift lands on the line you wrote: deploy examples/k8s-drift-to-source to a throwaway k3d cluster, `kubectl scale` it, and check `lifecycle diff --live` names the composite argument and its line (on-demand, needs Docker + k3d + kubectl). BREAK=1 scales the directly written Deployment and requires it attributed as direct.
drift-to-source-e2e:
    @scripts/human-gate.sh drift-to-source-e2e
    bash test/drift-to-source-e2e.sh

# Run all smoke tests (smoke-workspace, then smoke-npm; asks once)
smoke:
    @scripts/human-gate.sh smoke
    docker build -f test/Dockerfile.smoke -t chant-smoke-workspace . && docker run -it --rm chant-smoke-workspace
    ./test/smoke.sh npm

# Build unified documentation site (main + lexicon docs, includes diagrams)
docs-build:
    bash scripts/build-docs.sh

# Build and serve unified docs locally
docs-serve: docs-build
    npx serve .docs-dist

# Check every core docs page carries a Diátaxis quadrant matching its sidebar group
docs-check:
    node scripts/check-docs-diataxis.mjs

# Check internal doc links across the unified site (requires lychee: brew install lychee)
docs-check-links: docs-check docs-build
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

# Releases chant's npm packages as a release train (#5154, design #5132):
# dispatches .github/workflows/publish.yml, generated from release.workflow in
# release/chant.config.ts. The run picks the newest green main commit, cuts
# every member under release/ that `chant release changed` lists with
# `chant workspace train cut npm`, and publishes the train core first. The
# levels: auto (each member's commits and intent files decide; the default),
# one for every member, or <member>=<level>. --dry-run plans the train here
# at the newest green commit and writes nothing. The same train can be cut
# from here with `chant workspace train cut npm --levels ... --yes` in
# release/, which pushes the release-train/npm/<id> tag publish.yml runs on.
# Release chant's packages as a train (just release [auto|major|minor|patch] [<member>=major|minor|patch ...] [--dry-run])
release *args:
    #!/usr/bin/env bash
    set -euo pipefail
    levels=() dry=0
    for a in {{args}}; do
      case "$a" in
        --dry-run|-n) dry=1 ;;
        auto|major|minor|patch|*=major|*=minor|*=patch) levels+=("$a") ;;
        *) echo "release: $a is not a level (auto, major, minor, patch or <member>=<level>) or --dry-run" >&2; exit 2 ;;
      esac
    done
    l="${levels[*]:-auto}"
    if [ "$dry" = 1 ]; then
      git fetch --quiet origin main 'refs/tags/ci/*:refs/tags/ci/*'
      chant="npx tsx $PWD/packages/core/src/cli/main.ts"
      sha=$($chant ci last-green --from origin/main --json | jq -r '.commit.sha // empty')
      [ -n "$sha" ] || { echo "release: no green commit on main" >&2; exit 1; }
      cd release && $chant workspace train cut npm --at "$sha" --levels "$l"
    else
      gh workflow run publish.yml --ref main -f levels="$l"
      echo "Dispatched publish.yml with levels $l: gh run list -w publish.yml -L 1"
    fi

# Check that every contract floor names a released version or a local build
# stamp, or set the next release's number (#4480), or after <v> is published
# turn its floors into literals and move NEXT_RELEASE on (#4501)
# (just release-floors [--npm] [--release <v>] [--rev <sha>] | just release-floors --set <v>
#  | just release-floors --freeze <v> [--next <n>])
release-floors *args:
    npx tsx scripts/release-floors.ts {{args}}

# Bring main's head (or <commit>) to green and release it (#4218): start the
# missing phases, wait for them and the tick, dispatch `just release`, wait on
# the publish.yml run
# (just release-when-green [auto|major|minor|patch] [<member>=<level> ...] [<commit>] [--dry-run])
release-when-green *args:
    bash scripts/release-when-green.sh {{args}}

# Build Zed extension (WASM)
ext-zed-build:
    cd editors/zed && cargo build --release --target wasm32-wasip1
