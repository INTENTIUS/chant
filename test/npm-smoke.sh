#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for installing chant from tarballs and running build/lint.
# Works with both npm (node:22-slim) and bun (oven/bun) runtimes.
#
# Usage: RUNTIME=npm ./npm-smoke.sh   (default)
#        RUNTIME=bun ./npm-smoke.sh

RUNTIME="${RUNTIME:-npm}"

PASS=0
FAIL=0
ERRORS=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  - $1"; }

echo "=== Runtime: $RUNTIME ==="

# ── Helpers ───────────────────────────────────────────────────────────────────

pkg_install() {
  # Always use npm for tarball installs — bun add from tarballs doesn't
  # deduplicate transitive deps properly (installs a separate copy from
  # the npm registry alongside the tarball). Real users install from the
  # registry where this isn't an issue.
  npm install --no-audit --no-fund "$@"
}

pkg_run() {
  # Run a package bin (e.g. chant build src)
  if [ "$RUNTIME" = "bun" ]; then
    bunx "$@"
  else
    npx "$@"
  fi
}

pkg_init() {
  cat > package.json <<'PKGJSON'
{ "name": "test-project", "version": "0.0.1", "type": "module" }
PKGJSON
}

install_from_tarballs() {
  # $1 = lexicon tarball path (core always included)
  pkg_install /tarballs/core.tgz "$1"
}

# ── Test group 1: Manual projects (hand-crafted source files) ─────────────────

test_manual_project() {
  local lexicon="$1"    # e.g. "aws"
  local tarball="$2"    # e.g. "/tarballs/lexicon-aws.tgz"
  local source="$3"     # TypeScript source code
  local label="$RUNTIME-manual-$lexicon"

  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir/src"
  cd "$dir"

  pkg_init
  install_from_tarballs "$tarball"

  # Write the test source file
  echo "$source" > src/infra.ts

  # Build
  if pkg_run chant build src 2>&1; then
    pass "$label: chant build"
  else
    fail "$label: chant build"
  fi

  # Lint
  if pkg_run chant lint src 2>&1; then
    pass "$label: chant lint"
  else
    fail "$label: chant lint"
  fi
}

# AWS manual project
test_manual_project "aws" "/tarballs/lexicon-aws.tgz" \
  'import { defaultTags } from "@intentius/chant-lexicon-aws";
export const tags = defaultTags([{ Key: "Env", Value: "test" }]);'

# GitLab manual project
test_manual_project "gitlab" "/tarballs/lexicon-gitlab.tgz" \
  'import { Job } from "@intentius/chant-lexicon-gitlab";
export const build = new Job({ stage: "build", script: ["echo hello"] });'

# K8s manual project
test_manual_project "k8s" "/tarballs/lexicon-k8s.tgz" \
  'import { Deployment } from "@intentius/chant-lexicon-k8s";
export const app = new Deployment({
  metadata: { name: "test" },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: "test" } },
    template: {
      metadata: { labels: { app: "test" } },
      spec: { containers: [{ name: "app", image: "nginx:latest" }] },
    },
  },
});'


# ── Test group 2: chant init flow ─────────────────────────────────────────────

test_init_flow() {
  local lexicon="$1"    # e.g. "aws"
  local tarball="$2"    # e.g. "/tarballs/lexicon-aws.tgz"
  local source="$3"     # TypeScript source to write into src/
  local label="$RUNTIME-init-$lexicon"

  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"

  pkg_init

  # Install core first (provides the chant CLI)
  pkg_install /tarballs/core.tgz

  # Run chant init — --force because dir already has package.json + node_modules
  if pkg_run chant init --lexicon "$lexicon" --force . 2>&1; then
    pass "$label: chant init"
  else
    fail "$label: chant init"
    return
  fi

  # Install the lexicon tarball (init scaffolds the dep but can't resolve from tarball)
  pkg_install "$tarball"

  # Write a source file — init scaffolds config but not infra code
  mkdir -p src
  echo "$source" > src/infra.ts

  # Build the scaffolded project
  if pkg_run chant build src 2>&1; then
    pass "$label: chant build"
  else
    fail "$label: chant build"
  fi

  # Lint the scaffolded project
  if pkg_run chant lint src 2>&1; then
    pass "$label: chant lint"
  else
    fail "$label: chant lint"
  fi
}

test_init_flow "aws" "/tarballs/lexicon-aws.tgz" \
  'import { defaultTags } from "@intentius/chant-lexicon-aws";
export const tags = defaultTags([{ Key: "Env", Value: "smoke" }]);'

test_init_flow "gitlab" "/tarballs/lexicon-gitlab.tgz" \
  'import { Job } from "@intentius/chant-lexicon-gitlab";
export const deploy = new Job({ stage: "deploy", script: ["echo deploy"] });'

test_init_flow "k8s" "/tarballs/lexicon-k8s.tgz" \
  'import { Service } from "@intentius/chant-lexicon-k8s";
export const svc = new Service({
  metadata: { name: "smoke" },
  spec: { selector: { app: "smoke" }, ports: [{ port: 80 }] },
});'


# ── Test group 3: Real examples (build from example src directories) ──────────

test_example() {
  local name="$1"       # e.g. "flyway-postgresql-k8s"
  local label="$RUNTIME-example-$name"
  shift                 # remaining args: pairs of "tarball lexicon" ...

  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"

  pkg_init

  # Install core + all required lexicon tarballs
  local install_args=(/tarballs/core.tgz)
  local lexicons=()
  while [ $# -ge 2 ]; do
    install_args+=("$1")
    lexicons+=("$2")
    shift 2
  done
  pkg_install "${install_args[@]}"

  # Copy example source files
  cp -r "/examples/$name/src" src/

  # Copy .env.example if it exists (needed by k8s-eks-microservice)
  if [ -f "/examples/$name/.env.example" ]; then
    cp "/examples/$name/.env.example" .env
  fi

  # Build for each lexicon
  for lex in "${lexicons[@]}"; do
    if pkg_run chant build src --lexicon "$lex" 2>&1; then
      pass "$label: chant build --lexicon $lex"
    else
      fail "$label: chant build --lexicon $lex"
    fi
  done

  # Lint
  if pkg_run chant lint src 2>&1; then
    pass "$label: chant lint"
  else
    fail "$label: chant lint"
  fi
}

# Only run example tests if /examples directory exists (copied into Docker)
if [ -d /examples ]; then
  test_example "gitlab-aws-alb-infra" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-gitlab.tgz gitlab

  test_example "gitlab-aws-alb-api" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-gitlab.tgz gitlab

  test_example "gitlab-aws-alb-ui" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-gitlab.tgz gitlab

  test_example "flyway-postgresql-gitlab-aws-rds" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-flyway.tgz flyway \
    /tarballs/lexicon-gitlab.tgz gitlab

  test_example "k8s-eks-microservice" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-k8s.tgz k8s
else
  echo ""
  echo "=== Skipping example tests (/examples not found) ==="
fi


# ── Results ───────────────────────────────────────────────────────────────────

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\nFailures:$ERRORS"
  exit 1
fi
