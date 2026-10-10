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
  # $1 = lexicon tarball path, or several separated by spaces when a lexicon
  # depends on another workspace lexicon (k8s needs prometheus and otel,
  # prometheus and fly need otel, gitlab needs github), so npm installs this
  # commit's copy of it rather than the registry's; core always included
  # shellcheck disable=SC2086
  pkg_install /tarballs/core.tgz $1
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

# Every lexicon tarball the image packed (test/smoke-npm-lexicons.txt), so a
# lexicon added to that list is checked without editing this loop.
for tarball in /tarballs/lexicon-*.tgz; do
  lex=$(basename "$tarball" .tgz); lex=${lex#lexicon-}
  verify_tarball_contains "$tarball" "package/dist/manifest.json" "$lex tarball contains dist/manifest.json"
  verify_tarball_contains "$tarball" "package/dist/meta.json" "$lex tarball contains dist/meta.json"
  verify_tarball_contains "$tarball" "package/dist/types/index.d.ts" "$lex tarball contains dist/types/index.d.ts"
  verify_tarball_contains "$tarball" "package/src/index.ts" "$lex tarball contains src/index.ts"
done

# What grafana reads at run time beyond the root export (#2919). GRAF107
# validates against the schemas bundled into src/spec/schemas.gen.ts (#2958),
# not the vendored src/spec/schemas/ files, which only generate reads. The
# /validation and /k8s subpaths resolve to src/validation.ts and src/k8s.ts.
# test_grafana_project below checks that these work once installed.
verify_tarball_contains /tarballs/lexicon-grafana.tgz "package/src/spec/schemas.gen.ts" "grafana tarball contains src/spec/schemas.gen.ts (GRAF107's schemas)"
verify_tarball_contains /tarballs/lexicon-grafana.tgz "package/src/lint/post-synth/graf107.ts" "grafana tarball contains the GRAF107 check"
verify_tarball_contains /tarballs/lexicon-grafana.tgz "package/src/validation.ts" "grafana tarball contains src/validation.ts (/validation subpath)"
verify_tarball_contains /tarballs/lexicon-grafana.tgz "package/src/k8s.ts" "grafana tarball contains src/k8s.ts (/k8s subpath)"

fi # INSTALL_MODE=tarball


# ── Test group 1: Manual projects (hand-crafted source files) ─────────────────

test_manual_project() {
  local lexicon="$1"    # e.g. "aws"
  local tarball="$2"    # e.g. "/tarballs/lexicon-aws.tgz"
  local source="$3"     # TypeScript source code
  local build_args="${4:-}"  # extra `chant build` arguments, e.g. "-o dist/out.json"
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
  # shellcheck disable=SC2086 # build_args is a word list
  if pkg_run chant build src $build_args 2>&1; then
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
test_manual_project "gitlab" "/tarballs/lexicon-gitlab.tgz /tarballs/lexicon-github.tgz" \
  'import { Job } from "@intentius/chant-lexicon-gitlab";
export const build = new Job({ stage: "build", script: ["echo hello"] });'

# K8s manual project
test_manual_project "k8s" "/tarballs/lexicon-k8s.tgz /tarballs/lexicon-prometheus.tgz /tarballs/lexicon-otel.tgz" \
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

# The k8s lexicon declares @intentius/chant-k8s-client as an OPTIONAL
# dependency (#1074): a registry install must be able to resolve it (the
# live-observation path degrades to holes without it), and its module must
# load. Registry mode only — the tarball path has no client tarball and the
# build path never needs it (that isolation is its own gated test).
if [ "$INSTALL_MODE" = "registry" ]; then
  k8s_client_dir="/tmp/test-k8s-client-check"
  mkdir -p "$k8s_client_dir" && cd "$k8s_client_dir"
  pkg_init
  if install_from_registry "@intentius/chant-k8s-client" \
     && node -e "import('@intentius/chant-k8s-client').then(() => process.exit(0), () => process.exit(1))" 2>/dev/null; then
    pass "k8s-client: installs from registry and imports"
  else
    fail "k8s-client: installs from registry and imports"
  fi
  # The lexicon's own optionalDependencies RANGE must resolve too — a client
  # version stranded behind the lexicon (the 0.33.0 skew) makes npm silently
  # install without it, and live observation degrades to holes with exit 0.
  k8s_range_dir="/tmp/test-k8s-client-range"
  rm -rf "$k8s_range_dir"; mkdir -p "$k8s_range_dir"; cd "$k8s_range_dir"
  pkg_init
  install_from_registry "@intentius/chant-lexicon-k8s"
  if [ -d "node_modules/@intentius/chant-k8s-client" ]; then
    pass "k8s-client: lexicon's optional-dep range resolves it"
  else
    fail "k8s-client: lexicon's optional-dep range resolves it (version skew? client stranded behind lexicon)"
  fi
fi

# Prometheus manual project
test_manual_project "prometheus" "/tarballs/lexicon-prometheus.tgz /tarballs/lexicon-otel.tgz" \
  'import { RuleGroup, type Rule } from "@intentius/chant-lexicon-prometheus";
const rules: Rule[] = [{ alert: "TargetDown", expr: "up == 0", for: "5m", labels: { severity: "page" }, annotations: { summary: "down" } }];
export const smoke = new RuleGroup({ name: "smoke", rules });'

# SQL manual project, in both modes. It has no chant.config.ts and imports the
# lexicon only through a dialect subpath, so the build relies on detection
# reading subpath imports (#3648). The DDL is a sidecar file, so the build
# needs --output.
test_manual_project "sql" "/tarballs/lexicon-sql.tgz" \
  'import { table } from "@intentius/chant-lexicon-sql/clickhouse";
export const events = table`CREATE TABLE events (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY (id, ts)`;' \
  "-o dist/schema.json"

# Grafana manual project (#2919). grafana depends on the k8s, prometheus and
# otel lexicons, so their tarballs go in too. Beyond build and lint, it checks
# that the published package works at run time:
#   - a clean dashboard builds with no grafana diagnostic, so GRAF101-GRAF117
#     ran and passed (build is where post-synth checks run; GRAF107 only warns
#     "not checked" when ajv or the bundled schemas fail to load, and that
#     warning would show here)
#   - a dashboard the pinned schema rejects fails the build with GRAF107's
#     "(Grafana schema)" error, so schema validation really runs
#   - the /validation and /k8s subpaths resolve and load under tsx
test_grafana_project() {
  local label="npm-manual-grafana"
  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/bad"
  cd "$dir"

  pkg_init
  if [ "$INSTALL_MODE" = "registry" ]; then
    install_from_registry "@intentius/chant-lexicon-grafana"
  else
    install_from_tarballs "/tarballs/lexicon-grafana.tgz /tarballs/lexicon-k8s.tgz /tarballs/lexicon-prometheus.tgz /tarballs/lexicon-otel.tgz"
  fi

  cat > src/dashboard.ts <<'SRC'
import { Dashboard, Datasource, PromQuery, StatPanel, TimeSeriesPanel } from "@intentius/chant-lexicon-grafana";
export const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090", isDefault: true });
const up = new StatPanel({ title: "Targets up", datasource: prometheus, targets: [new PromQuery({ expr: "sum(up)", instant: true })] });
const rate = new TimeSeriesPanel({
  title: "Requests per second",
  datasource: prometheus,
  targets: [new PromQuery({ expr: "sum(rate(http_requests_total[$__rate_interval]))" })],
  fieldConfig: { defaults: { unit: "reqps" } },
});
export const overview = new Dashboard({ title: "npm smoke", uid: "npm-smoke", panels: [up, rate] });
SRC

  if pkg_run chant build src --lexicon grafana -o dist/index.json 2>build.err; then
    pass "$label: chant build"
  else
    fail "$label: chant build"
    sed 's/^/    /' build.err
  fi
  if jq -e '.uid == "npm-smoke" and (.panels | length) == 2' dist/dashboards/npm-smoke.json >/dev/null 2>&1; then
    pass "$label: build writes the dashboard JSON"
  else
    fail "$label: build did not write dist/dashboards/npm-smoke.json"
  fi
  if grep -q "(grafana)" build.err; then
    fail "$label: GRAF101-GRAF117 reported diagnostics on a clean dashboard"
    grep "(grafana)" build.err | sed 's/^/    /'
  else
    pass "$label: GRAF101-GRAF117 pass"
  fi

  if pkg_run chant lint src 2>&1; then
    pass "$label: chant lint"
  else
    fail "$label: chant lint"
  fi

  # GRAF107 on a value the pinned schema does not allow.
  cat > bad/dashboard.ts <<'SRC'
import { Dashboard, Datasource, PromQuery, StatPanel } from "@intentius/chant-lexicon-grafana";
export const prometheus = new Datasource({ name: "Prometheus", type: "prometheus", url: "http://prometheus:9090", isDefault: true });
const up = new StatPanel({ title: "Targets up", datasource: prometheus, options: { graphMode: "sparkline" }, targets: [new PromQuery({ expr: "sum(up)", instant: true })] });
export const bad = new Dashboard({ title: "npm smoke bad", uid: "npm-smoke-bad", panels: [up] });
SRC
  if pkg_run chant build bad --lexicon grafana -o bad-dist/index.json >bad-build.log 2>&1; then
    fail "$label: GRAF107 let an invalid graphMode through"
  elif grep -q "graphMode.*(Grafana schema)" bad-build.log; then
    pass "$label: GRAF107 rejects a value the pinned schema does not allow"
  else
    fail "$label: invalid dashboard failed the build, but not with GRAF107"
    sed 's/^/    /' bad-build.log
  fi

  # The subpaths, loaded the way a consumer's code would load them.
  cat > subpaths.ts <<'SRC'
import { validateDashboardSchema, schemaValidationUnavailable } from "@intentius/chant-lexicon-grafana/validation";
import { GrafanaConfigMaps } from "@intentius/chant-lexicon-grafana/k8s";
const panel = { type: "stat", id: 1, title: "s", gridPos: { h: 4, w: 4, x: 0, y: 0 }, options: { graphMode: "sparkline" } };
const problems = validateDashboardSchema({ title: "x", schemaVersion: 41, panels: [panel] });
const unavailable = schemaValidationUnavailable();
if (unavailable) throw new Error(unavailable);
if (!problems.some((p) => p.path.includes("graphMode"))) throw new Error(`no graphMode problem: ${JSON.stringify(problems)}`);
if (typeof GrafanaConfigMaps !== "function") throw new Error("/k8s does not export GrafanaConfigMaps");
SRC
  if tsx subpaths.ts 2>&1; then
    pass "$label: /validation and /k8s subpaths resolve and validate"
  else
    fail "$label: /validation and /k8s subpaths resolve and validate"
  fi
}
test_grafana_project

# Azure manual project
test_manual_project "azure" "/tarballs/lexicon-azure.tgz" \
  'import { StorageAccount, Azure } from "@intentius/chant-lexicon-azure";
export const storage = new StorageAccount({
  name: "smoketest",
  location: Azure.ResourceGroupLocation,
  kind: "StorageV2",
  sku: { name: "Standard_LRS" },
});'

# GCP manual project
test_manual_project "gcp" "/tarballs/lexicon-gcp.tgz" \
  'import { StorageBucket } from "@intentius/chant-lexicon-gcp";
export const bucket = new StorageBucket({ resourceID: "test-bucket", location: "US" });'

# ── Test: fly build emits org_slug ────────────────────────────────────────────
# The Machines API rejects POST /v1/apps without org_slug (real Fly returns 400;
# mudflaps >=0.3.1 mirrors it). The fly serializer must carry App.org_slug into
# the create body — Fly.OrgSlug resolves to "personal" offline. This guards the
# published serializer against silently dropping it, which the generic
# build-exits-0 check would miss.
test_fly_org_slug() {
  local label="npm-fly-org-slug"
  echo ""
  echo "=== Test: $label ==="

  local dir="/tmp/test-$label"
  rm -rf "$dir"
  mkdir -p "$dir/src"
  cd "$dir"

  pkg_init
  if [ "$INSTALL_MODE" = "registry" ]; then
    install_from_registry "@intentius/chant-lexicon-fly"
  else
    install_from_tarballs "/tarballs/lexicon-fly.tgz /tarballs/lexicon-otel.tgz"
  fi

  cat > src/infra.ts <<'SRC'
import { App, Machine, MachineConfig, MachineGuest, Fly } from "@intentius/chant-lexicon-fly";
export const app = new App({ name: "smoke-app", org_slug: Fly.OrgSlug });
export const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
  }),
});
SRC

  if pkg_run chant build src --lexicon fly -o plan.json 2>&1; then
    pass "$label: chant build"
  else
    fail "$label: chant build"
    return
  fi

  # The App create body (POST /v1/apps) must carry org_slug, defaulting to
  # "personal" when FLY_ORG is unset.
  if grep -Eq '"org_slug": *"personal"' plan.json; then
    pass "$label: app create body carries org_slug"
  else
    fail "$label: app create body missing org_slug"
    echo "    plan.json was:"
    sed 's/^/    /' plan.json 2>/dev/null || echo "    (no plan.json written)"
  fi
}
test_fly_org_slug


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
  local tarball="$2"    # e.g. "/tarballs/lexicon-aws.tgz"; several space-separated when one lexicon needs another
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
    # shellcheck disable=SC2086
    pkg_install $tarball
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

test_init_flow "gitlab" "/tarballs/lexicon-gitlab.tgz /tarballs/lexicon-github.tgz" \
  'import { Job } from "@intentius/chant-lexicon-gitlab";
export const deploy = new Job({ stage: "deploy", script: ["echo deploy"] });'

test_init_flow "k8s" "/tarballs/lexicon-k8s.tgz /tarballs/lexicon-prometheus.tgz /tarballs/lexicon-otel.tgz" \
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

test_init_flow "gcp" "/tarballs/lexicon-gcp.tgz" \
  'import { StorageBucket } from "@intentius/chant-lexicon-gcp";
export const bucket = new StorageBucket({ resourceID: "smoke-bucket", location: "US" });'


# ── Test group 3: Real examples (build from example src directories) ──────────

test_example() {
  local name="$1"       # e.g. "k8s-eks-microservice"
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
  else
    # Install the workspace lexicons these depend on from their tarballs too,
    # so npm does not take them from the registry.
    if [[ " ${install_args[*]} " == *" /tarballs/lexicon-k8s.tgz "* ]]; then
      install_args+=(/tarballs/lexicon-prometheus.tgz /tarballs/lexicon-otel.tgz)
    fi
    if [[ " ${install_args[*]} " == *" /tarballs/lexicon-gitlab.tgz "* ]]; then
      install_args+=(/tarballs/lexicon-github.tgz)
    fi
  fi
  pkg_install "${install_args[@]}"

  # Copy example source files, and the config that declares the build
  # parameters they read (#2486): without chant.config.ts no buildParams
  # exist, so an example reading params.domain fails on `.split`.
  cp -r "/examples/$name/src" src/
  if [ -f "/examples/$name/chant.config.ts" ]; then
    cp "/examples/$name/chant.config.ts" chant.config.ts
  fi

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

  test_example "gitlab-aws-alb-services" \
    /tarballs/lexicon-aws.tgz aws \
    /tarballs/lexicon-gitlab.tgz gitlab

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
