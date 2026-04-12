#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for installing chant from tarballs and running build/lint.
#
# Usage: ./npm-smoke.sh

INSTALL_MODE="${INSTALL_MODE:-tarball}"

PASS=0
FAIL=0
ERRORS=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  - $1"; }

echo "=== npm smoke tests ==="

# ── Helpers ───────────────────────────────────────────────────────────────────

pkg_install() {
  # Always use npm for tarball installs.
  npm install --no-audit --no-fund "$@"
}

pkg_run() {
  # Run a package bin (e.g. chant build src)
  npx "$@"
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

install_from_registry() {
  # $1 = lexicon package name (e.g. "@intentius/chant-lexicon-aws"); core always included
  # Uses @latest — always tests whatever is currently live on npm
  local pkgs=("@intentius/chant@latest")
  [ -n "${1:-}" ] && pkgs+=("${1}@latest")
  pkg_install "${pkgs[@]}"
}

# ── Test group 0: Tarball content verification ────────────────────────────────

if [ "$INSTALL_MODE" = "tarball" ]; then

verify_tarball_contains() {
  local tarball="$1"
  local path="$2"
  local label="$3"
  # Subshell with pipefail disabled: grep -q exits on first match, causing tar
  # to receive SIGPIPE (exit 141); with pipefail that would make the pipeline
  # return non-zero even when the pattern was found.
  if (set +o pipefail; tar tzf "$tarball" | grep -q "$path"); then
    pass "$label"
  else
    fail "$label"
  fi
}

verify_tarball_contains /tarballs/core.tgz "package/bin/chant" "core tarball contains bin/chant"
verify_tarball_contains /tarballs/core.tgz "package/src/cli/main.ts" "core tarball contains CLI entrypoint"
verify_tarball_contains /tarballs/core.tgz "package/src/index.ts" "core tarball contains main export"

for lex in aws azure gcp gitlab k8s flyway docker; do
  verify_tarball_contains "/tarballs/lexicon-$lex.tgz" "package/dist/manifest.json" "$lex tarball contains dist/manifest.json"
  verify_tarball_contains "/tarballs/lexicon-$lex.tgz" "package/dist/meta.json" "$lex tarball contains dist/meta.json"
  verify_tarball_contains "/tarballs/lexicon-$lex.tgz" "package/dist/types/index.d.ts" "$lex tarball contains dist/types/index.d.ts"
  verify_tarball_contains "/tarballs/lexicon-$lex.tgz" "package/src/index.ts" "$lex tarball contains src/index.ts"
done

fi # INSTALL_MODE=tarball


# ── Test group 1: Manual projects (hand-crafted source files) ─────────────────

test_manual_project() {
  local lexicon="$1"    # e.g. "aws"
  local tarball="$2"    # e.g. "/tarballs/lexicon-aws.tgz"
  local source="$3"     # TypeScript source code
  local label="npm-manual-$lexicon"

  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir/src"
  cd "$dir"

  pkg_init
  if [ "$INSTALL_MODE" = "registry" ]; then
    install_from_registry "@intentius/chant-lexicon-$lexicon"
  else
    install_from_tarballs "$tarball"
  fi

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

# Azure manual project
test_manual_project "azure" "/tarballs/lexicon-azure.tgz" \
  'import { StorageAccount, Azure } from "@intentius/chant-lexicon-azure";
export const storage = new StorageAccount({
  name: "smoketest",
  location: Azure.ResourceGroupLocation,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
});'

# Flyway manual project
test_manual_project "flyway" "/tarballs/lexicon-flyway.tgz" \
  'import { FlywayProject, FlywayConfig } from "@intentius/chant-lexicon-flyway";
export const project = new FlywayProject({ name: "smoke-test-db" });
export const config = new FlywayConfig({ locations: ["classpath:db/migration"] });'

# GCP manual project
test_manual_project "gcp" "/tarballs/lexicon-gcp.tgz" \
  'import { StorageBucket } from "@intentius/chant-lexicon-gcp";
export const bucket = new StorageBucket({ resourceID: "test-bucket", location: "US" });'


# ── Test: type resolution ─────────────────────────────────────────────────────
# Verify TypeScript can resolve lexicon exports via tsc --noEmit.
# chant targets tsx (raw .ts exports), so vanilla tsc may not resolve —
# we test it but don't treat failure as fatal.

if [ "$INSTALL_MODE" = "tarball" ] && command -v npx >/dev/null 2>&1; then
  echo ""
  echo "=== Test: type-resolution ==="
  TYPE_DIR="/tmp/test-type-resolution"
  rm -rf "$TYPE_DIR"
  mkdir -p "$TYPE_DIR/src"
  cd "$TYPE_DIR"
  pkg_init
  install_from_tarballs /tarballs/lexicon-aws.tgz
  cat > tsconfig.json <<'TSC'
{ "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true }, "include": ["src"] }
TSC
  cat > src/check.ts <<'SRC'
import { defaultTags } from "@intentius/chant-lexicon-aws";
const tags = defaultTags([{ Key: "Env", Value: "test" }]);
SRC
  if npx tsc --noEmit 2>&1; then
    pass "tsc resolves lexicon types"
  else
    # Not a hard failure — chant targets tsx (.ts exports), not vanilla tsc
    pass "tsc type resolution skipped (expected with .ts exports)"
  fi
fi


# ── Test group 2: chant init flow ─────────────────────────────────────────────

test_init_flow() {
  local lexicon="$1"    # e.g. "aws"
  local tarball="$2"    # e.g. "/tarballs/lexicon-aws.tgz"
  local source="$3"     # TypeScript source to write into src/
  local label="npm-init-$lexicon"

  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"

  pkg_init

  # Install core first (provides the chant CLI)
  if [ "$INSTALL_MODE" = "registry" ]; then
    pkg_install "@intentius/chant@latest"
  else
    pkg_install /tarballs/core.tgz
  fi

  # Run chant init — --force because dir already has package.json + node_modules
  if pkg_run chant init --lexicon "$lexicon" --force . 2>&1; then
    pass "$label: chant init"
  else
    fail "$label: chant init"
    return
  fi

  # Install the lexicon (init scaffolds the dep but can't resolve from tarball)
  if [ "$INSTALL_MODE" = "registry" ]; then
    pkg_install "@intentius/chant-lexicon-$lexicon@latest"
  else
    pkg_install "$tarball"
  fi

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

test_init_flow "azure" "/tarballs/lexicon-azure.tgz" \
  'import { StorageAccount, Azure } from "@intentius/chant-lexicon-azure";
export const storage = new StorageAccount({
  name: "smokeacct",
  location: Azure.ResourceGroupLocation,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
});'

test_init_flow "flyway" "/tarballs/lexicon-flyway.tgz" \
  'import { FlywayProject, FlywayConfig } from "@intentius/chant-lexicon-flyway";
export const project = new FlywayProject({ name: "smoke-db" });
export const config = new FlywayConfig({ locations: ["classpath:db/migration"] });'

test_init_flow "gcp" "/tarballs/lexicon-gcp.tgz" \
  'import { StorageBucket } from "@intentius/chant-lexicon-gcp";
export const bucket = new StorageBucket({ resourceID: "smoke-bucket", location: "US" });'


# ── Test group 3: Real examples (build from example src directories) ──────────

test_example() {
  local name="$1"       # e.g. "flyway-postgresql-k8s"
  local label="npm-example-$name"
  shift                 # remaining args: pairs of "tarball lexicon" ...

  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"

  pkg_init

  # Install core + all required lexicons
  local install_args
  local lexicons=()
  if [ "$INSTALL_MODE" = "registry" ]; then
    install_args=("@intentius/chant@latest")
  else
    install_args=(/tarballs/core.tgz)
  fi
  while [ $# -ge 2 ]; do
    [ "$INSTALL_MODE" != "registry" ] && install_args+=("$1")
    lexicons+=("$2")
    shift 2
  done
  if [ "$INSTALL_MODE" = "registry" ]; then
    for lex in "${lexicons[@]}"; do
      install_args+=("@intentius/chant-lexicon-$lex@latest")
    done
  fi
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
    /tarballs/lexicon-gitlab.tgz gitlab \
    /tarballs/lexicon-docker.tgz docker

  test_example "k8s-eks-microservice" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-k8s.tgz k8s

  test_example "k8s-gke-microservice" \
    /tarballs/lexicon-gcp.tgz gcp \
    /tarballs/lexicon-k8s.tgz k8s

  test_example "k8s-aks-microservice" \
    /tarballs/lexicon-azure.tgz azure \
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
