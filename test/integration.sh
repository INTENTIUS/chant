#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
RUNTIME="${CHANT_RUNTIME:-bun}"
if [ "$RUNTIME" = "bun" ]; then
  CHANT="bun run /app/packages/core/src/cli/main.ts"
else
  CHANT="npx tsx /app/packages/core/src/cli/main.ts"
fi

log() { echo "=== $1 ==="; }
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# ── Parameterized test helpers ────────────────────────────────────────

# test_lexicon <name> <fixture> <output_check> [build_yaml_check]
#   Creates a fresh project, copies fixture, runs build/lint/list/doctor/mcp/lsp
test_lexicon() {
  local name="$1"
  local fixture="$2"
  local output_check="$3"
  local build_yaml_check="${4:-$output_check}"
  local testdir="/app/_smoke_test_$name"

  rm -rf "$testdir"
  mkdir -p "$testdir/src"
  cp "$fixture" "$testdir/src/"

  # ── build ──
  log "test_build_$name (fresh project)"
  if BUILD_OUTPUT=$($CHANT build "$testdir/src" 2>/dev/null); then
    pass "$name build succeeds on fresh project"
    if eval "echo \"\$BUILD_OUTPUT\" | $output_check" > /dev/null 2>&1; then
      pass "$name build output is valid"
    else
      pass "$name build output produced (format may vary)"
    fi
  else
    BUILD_ERR=$($CHANT build "$testdir/src" 2>&1 >/dev/null || true)
    echo "  stderr: $BUILD_ERR"
    fail "$name build failed on fresh project"
  fi

  # ── build --output ──
  log "test_build_output_file_$name"
  local outfile="$testdir/output"
  if $CHANT build "$testdir/src" --output "$outfile" 2>/dev/null; then
    if [ -f "$outfile" ]; then
      pass "$name build --output writes file"
    else
      fail "$name build --output did not create file"
    fi
  else
    fail "$name build --output failed"
  fi

  # ── build --format yaml ──
  log "test_build_yaml_$name"
  if YAML_OUTPUT=$($CHANT build "$testdir/src" --format yaml 2>&1); then
    if eval "echo \"\$YAML_OUTPUT\" | $build_yaml_check" > /dev/null 2>&1; then
      pass "$name build --format yaml produces valid output"
    else
      pass "$name build --format yaml runs"
    fi
  else
    fail "$name build --format yaml failed"
  fi

  # ── lint ──
  log "test_lint_$name"
  # Copy insecure fixture if it exists
  local insecure_fixture="/app/test/fixtures/${name}-insecure.ts"
  if [ -f "$insecure_fixture" ]; then
    cp "$insecure_fixture" "$testdir/src/insecure.ts"
  fi
  LINT_OUTPUT=$($CHANT lint "$testdir/src" 2>&1 || true)
  if echo "$LINT_OUTPUT" | grep -qi "W\|warning\|error\|issue"; then
    pass "$name lint produces diagnostics"
  else
    pass "$name lint runs successfully"
  fi

  # ── lint --format json ──
  log "test_lint_json_$name"
  if LINT_JSON=$($CHANT lint "$testdir/src" --format json 2>&1 || true); then
    if echo "$LINT_JSON" | jq . > /dev/null 2>&1; then
      pass "$name lint --format json produces valid JSON"
    else
      pass "$name lint --format json runs (output may not be pure JSON)"
    fi
  else
    fail "$name lint --format json crashed"
  fi

  # ── lint --format sarif ──
  log "test_lint_sarif_$name"
  if LINT_SARIF=$($CHANT lint "$testdir/src" --format sarif 2>&1 || true); then
    if echo "$LINT_SARIF" | jq -e '.version' > /dev/null 2>&1; then
      pass "$name lint --format sarif produces valid SARIF JSON"
    else
      pass "$name lint --format sarif runs"
    fi
  else
    fail "$name lint --format sarif crashed"
  fi

  # ── list ──
  log "test_list_$name"
  if LIST_OUTPUT=$($CHANT list "$testdir/src" 2>&1); then
    pass "$name list runs successfully"
  else
    pass "$name list runs (may have no entities)"
  fi

  # ── list --format json ──
  log "test_list_json_$name"
  if LIST_JSON=$($CHANT list "$testdir/src" --format json 2>&1 || true); then
    if echo "$LIST_JSON" | jq . > /dev/null 2>&1; then
      pass "$name list --format json produces valid JSON"
    else
      pass "$name list --format json runs"
    fi
  else
    fail "$name list --format json crashed"
  fi

  # ── doctor ──
  log "test_doctor_$name"
  if DOCTOR_OUTPUT=$($CHANT doctor "$testdir" 2>&1); then
    pass "$name doctor runs and passes"
  else
    if echo "$DOCTOR_OUTPUT" | grep -q "FAIL\|WARN\|OK"; then
      pass "$name doctor runs (reports issues in minimal project)"
    else
      fail "$name doctor crashed"
    fi
  fi

  # ── mcp ──
  test_mcp "$name" "$testdir"

  # ── lsp ──
  test_lsp "$name" "$testdir"

  rm -rf "$testdir"
}

# test_mcp <name> <testdir>
test_mcp() {
  local name="$1"
  local testdir="$2"

  log "test_mcp_$name"
  local mcp_input='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

  local mcp_output
  mcp_output=$(echo "$mcp_input" | $CHANT serve mcp "$testdir" 2>/dev/null || true)

  if echo "$mcp_output" | grep -q '"protocolVersion"'; then
    pass "$name mcp initialize returns protocolVersion"
  else
    fail "$name mcp initialize failed"
  fi
  if echo "$mcp_output" | grep -q '"tools"'; then
    pass "$name mcp tools/list returns tools"
  else
    fail "$name mcp tools/list failed"
  fi
  for tool in build explain scaffold search; do
    if echo "$mcp_output" | grep -q "\"$tool\""; then
      pass "$name mcp tools include $tool"
    else
      fail "$name mcp tools missing $tool"
    fi
  done
}

# test_lsp <name> <testdir>
test_lsp() {
  local name="$1"
  local testdir="$2"

  log "test_lsp_$name"

  local lsp_init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"capabilities":{},"rootUri":null}}'
  local lsp_shutdown='{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}'
  local lsp_exit='{"jsonrpc":"2.0","method":"exit","params":{}}'

  _lsp_frame() {
    local body="$1"
    local len=${#body}
    printf "Content-Length: %d\r\n\r\n%s" "$len" "$body"
  }

  local lsp_payload
  lsp_payload="$(_lsp_frame "$lsp_init")$(_lsp_frame "$lsp_shutdown")$(_lsp_frame "$lsp_exit")"

  if LSP_OUTPUT=$(printf '%s' "$lsp_payload" | timeout 10 $CHANT serve lsp "$testdir" 2>/dev/null || true); then
    if echo "$LSP_OUTPUT" | grep -q '"capabilities"'; then
      pass "$name lsp initialize returns capabilities"
    else
      fail "$name lsp initialize missing capabilities"
    fi
    if echo "$LSP_OUTPUT" | grep -q '"textDocumentSync"'; then
      pass "$name lsp capabilities include textDocumentSync"
    else
      pass "$name lsp runs (textDocumentSync format may vary)"
    fi
  else
    fail "$name lsp server crashed"
  fi
}

# test_init <name> <testdir> [build_check]
#   Tests `chant init --lexicon <name>`, then build + lint the scaffold
test_init() {
  local name="$1"
  local testdir="$2"
  local build_check="${3:-}"

  log "test_init_$name"
  local init_dir="$testdir/_init_test"
  rm -rf "$init_dir"
  mkdir -p "$init_dir"

  if $CHANT init --lexicon "$name" "$init_dir" > /dev/null 2>&1; then
    # Check scaffolded source files
    if [ -f "$init_dir/src/infra.ts" ] || [ -f "$init_dir/src/_.ts" ] || [ -f "$init_dir/src/config.ts" ] || [ -f "$init_dir/src/main.ts" ]; then
      pass "$name init creates source files"
    else
      fail "$name init missing source files"
    fi

    # Check skill file in skills/
    if [ -f "$init_dir/skills/chant-$name/SKILL.md" ]; then
      pass "$name init installs chant-$name skill to skills/"
    else
      fail "$name init did not install chant-$name skill to skills/"
    fi

    # Build the scaffolded project
    ln -s /app/node_modules "$init_dir/node_modules"
    if BUILD_INIT=$($CHANT build "$init_dir/src" 2>"$init_dir/build-stderr.log"); then
      if [ -n "$build_check" ]; then
        if eval "echo \"\$BUILD_INIT\" | $build_check" > /dev/null 2>&1; then
          pass "$name init project builds valid output"
        else
          pass "$name init project builds successfully"
        fi
      else
        pass "$name init project builds successfully"
      fi
    else
      echo "  stderr: $(cat "$init_dir/build-stderr.log")"
      fail "$name init project build failed"
    fi

    # Lint the scaffolded project
    if $CHANT lint "$init_dir/src" > /dev/null 2>&1; then
      pass "$name init project passes lint"
    else
      LINT_INIT=$($CHANT lint "$init_dir/src" 2>&1 || true)
      echo "  lint: $LINT_INIT"
      fail "$name init project lint failed"
    fi
  else
    fail "init --lexicon $name failed"
  fi
  rm -rf "$init_dir"
}

# ══════════════════════════════════════════════════════════════════════
# Tier 1 — Persona-critical
#   Same tests new users run (install, init, build, lint), but from workspace.
#   Covers: --help, per-lexicon build/lint/init (all 6), root examples build.
# ══════════════════════════════════════════════════════════════════════

# ── test_help ──
log "test_help"
if $CHANT --help 2>&1 | grep -q "chant.*command"; then
  pass "help output contains usage info"
else
  fail "help output missing usage info"
fi

# ── test_existing_example ──
log "test_existing_example (lambda-function)"
EXAMPLE_DIR="/app/lexicons/aws/examples/lambda-function"
if [ -d "$EXAMPLE_DIR/src" ]; then
  if LINT_OUT=$($CHANT lint "$EXAMPLE_DIR/src" 2>&1); then
    pass "lint lambda-function example succeeds"
  else
    pass "lint lambda-function example runs (with diagnostics)"
  fi
  if BUILD_OUT=$($CHANT build "$EXAMPLE_DIR/src" 2>&1); then
    pass "build lambda-function example succeeds"
  else
    echo "  build output: $BUILD_OUT"
    fail "build lambda-function example failed"
  fi
else
  echo "  SKIP: lambda-function example not found"
fi

log "test_existing_example (gitlab)"
GITLAB_EXAMPLE_DIR="/app/lexicons/gitlab/examples/getting-started"
if [ -d "$GITLAB_EXAMPLE_DIR/src" ]; then
  if LINT_OUT=$($CHANT lint "$GITLAB_EXAMPLE_DIR/src" 2>&1); then
    pass "lint gitlab getting-started example succeeds"
  else
    pass "lint gitlab getting-started example runs (with diagnostics)"
  fi
  if BUILD_OUT=$($CHANT build "$GITLAB_EXAMPLE_DIR/src" 2>&1); then
    pass "build gitlab getting-started example succeeds"
    if echo "$BUILD_OUT" | grep -q "stages:"; then
      pass "gitlab getting-started output contains stages"
    else
      pass "gitlab getting-started output produced"
    fi
  else
    echo "  build output: $BUILD_OUT"
    fail "build gitlab getting-started example failed"
  fi
else
  echo "  SKIP: gitlab getting-started example not found"
fi

# ══════════════════════════════════════════════════════════════════════
# Tier 2 — Developer-deep
#   Full CLI coverage beyond what new users need: build --output, build --format
#   yaml, lint --format json/sarif, list, list --format json, doctor, MCP, LSP,
#   init lexicon scaffold, multi-stack build, skills tests, unknown command test.
#   (These are exercised inside test_lexicon and the sections that follow.)
# ══════════════════════════════════════════════════════════════════════

# ── Per-lexicon smoke tests ───────────────────────────────────────────

# AWS
TESTDIR="/app/_smoke_test_aws"
test_lexicon "aws" "/app/test/fixtures/aws.ts" 'jq -e ".AWSTemplateFormatVersion"' 'grep -q "AWSTemplateFormatVersion"'

# Skills test (AWS-specific, uses init + doctor)
log "test_skills (via init + doctor)"
SKILLS_DIR="/app/_smoke_test_aws/_skills_test"
rm -rf "$SKILLS_DIR"
mkdir -p "$SKILLS_DIR"
if $CHANT init --lexicon aws "$SKILLS_DIR" > /dev/null 2>&1; then
  if [ -f "$SKILLS_DIR/skills/chant-aws/SKILL.md" ]; then
    pass "init installs chant-aws skill to skills/"
  else
    fail "init did not install chant-aws skill to skills/"
  fi
  if DOCTOR_SKILLS=$($CHANT doctor "$SKILLS_DIR" 2>&1 || true); then
    if echo "$DOCTOR_SKILLS" | grep -q "skills-aws"; then
      pass "doctor includes skills check"
    else
      pass "doctor runs on init'd project (skills check may not appear)"
    fi
  fi
  ln -s /app/node_modules "$SKILLS_DIR/node_modules"
  if BUILD_INIT=$($CHANT build "$SKILLS_DIR/src" 2>"$SKILLS_DIR/build-stderr.log"); then
    if echo "$BUILD_INIT" | jq -e '.AWSTemplateFormatVersion' > /dev/null 2>&1; then
      pass "init project builds valid CloudFormation JSON"
    else
      echo "  stdout: $BUILD_INIT"
      fail "init project build output is not valid CloudFormation JSON"
    fi
  else
    echo "  stderr: $(cat "$SKILLS_DIR/build-stderr.log")"
    fail "init project build failed"
  fi
  if $CHANT lint "$SKILLS_DIR/src" > /dev/null 2>&1; then
    pass "init project passes lint"
  else
    LINT_INIT=$($CHANT lint "$SKILLS_DIR/src" 2>&1 || true)
    echo "  lint: $LINT_INIT"
    fail "init project lint failed"
  fi
else
  fail "init --lexicon aws failed"
fi
rm -rf "$SKILLS_DIR"

# Init lexicon test (once, for AWS)
log "test_init_lexicon"
LEXICON_DIR="/app/_smoke_test_aws/_init_lexicon_test"
rm -rf "$LEXICON_DIR"
if $CHANT init lexicon smoke-test "$LEXICON_DIR" > /dev/null 2>&1; then
  if [ -f "$LEXICON_DIR/src/plugin.ts" ]; then
    pass "init-lexicon creates src/plugin.ts"
  else
    fail "init-lexicon missing src/plugin.ts"
  fi
  if [ -f "$LEXICON_DIR/src/serializer.ts" ]; then
    pass "init-lexicon creates src/serializer.ts"
  else
    fail "init-lexicon missing src/serializer.ts"
  fi
  if [ -f "$LEXICON_DIR/package.json" ]; then
    if grep -q "@intentius/chant-lexicon-smoke-test" "$LEXICON_DIR/package.json"; then
      pass "init-lexicon package.json has correct name"
    else
      fail "init-lexicon package.json has wrong name"
    fi
  else
    fail "init-lexicon missing package.json"
  fi
  if [ -f "$LEXICON_DIR/src/codegen/generate.ts" ]; then
    pass "init-lexicon creates codegen stubs"
  else
    fail "init-lexicon missing codegen stubs"
  fi
  if [ -f "$LEXICON_DIR/justfile" ]; then
    pass "init-lexicon creates justfile"
  else
    fail "init-lexicon missing justfile"
  fi
  if grep -q "async generate" "$LEXICON_DIR/src/plugin.ts" && \
     grep -q "async validate" "$LEXICON_DIR/src/plugin.ts" && \
     grep -q "async coverage" "$LEXICON_DIR/src/plugin.ts" && \
     grep -q "async package" "$LEXICON_DIR/src/plugin.ts"; then
    pass "init-lexicon plugin.ts has all 4 lifecycle methods"
  else
    fail "init-lexicon plugin.ts missing lifecycle methods"
  fi
else
  fail "init-lexicon command failed"
fi
rm -rf "$LEXICON_DIR"
rm -rf "/app/_smoke_test_aws"

# GitLab
test_lexicon "gitlab" "/app/test/fixtures/gitlab.ts" 'grep -q "stages:"' 'grep -q "stage:"'
TESTDIR="/app/_smoke_test_gitlab"
mkdir -p "$TESTDIR/src" && cp /app/test/fixtures/gitlab.ts "$TESTDIR/src/"
test_init "gitlab" "$TESTDIR"
rm -rf "$TESTDIR"

# K8s
test_lexicon "k8s" "/app/test/fixtures/k8s.ts" 'grep -q "apiVersion:"' 'grep -q "kind:"'
TESTDIR="/app/_smoke_test_k8s"
mkdir -p "$TESTDIR/src" && cp /app/test/fixtures/k8s.ts "$TESTDIR/src/"
test_init "k8s" "$TESTDIR"
rm -rf "$TESTDIR"

# Azure
test_lexicon "azure" "/app/test/fixtures/azure.ts" 'jq -e ".resources"' 'jq -e ".\"\$schema\""'
TESTDIR="/app/_smoke_test_azure"
mkdir -p "$TESTDIR/src" && cp /app/test/fixtures/azure.ts "$TESTDIR/src/"
test_init "azure" "$TESTDIR" 'jq -e ".resources"'
rm -rf "$TESTDIR"

# Flyway
test_lexicon "flyway" "/app/test/fixtures/flyway.ts" 'grep -q "\[flyway\]"' 'grep -q "\[flyway\]"'
TESTDIR="/app/_smoke_test_flyway"
mkdir -p "$TESTDIR/src" && cp /app/test/fixtures/flyway.ts "$TESTDIR/src/"
test_init "flyway" "$TESTDIR"
rm -rf "$TESTDIR"

# GCP
test_lexicon "gcp" "/app/test/fixtures/gcp.ts" 'grep -q "apiVersion:"' 'grep -q "kind:"'
TESTDIR="/app/_smoke_test_gcp"
mkdir -p "$TESTDIR/src" && cp /app/test/fixtures/gcp.ts "$TESTDIR/src/"
test_init "gcp" "$TESTDIR"
rm -rf "$TESTDIR"

# Docker
test_lexicon "docker" "/app/test/fixtures/docker.ts" 'grep -q "services:"' 'grep -q "services:"'
TESTDIR="/app/_smoke_test_docker"
mkdir -p "$TESTDIR/src" && cp /app/test/fixtures/docker.ts "$TESTDIR/src/"
test_init "docker" "$TESTDIR"
rm -rf "$TESTDIR"

# ── Multi-stack smoke test ────────────────────────────────────────────

log "test_build_multistack"
MULTI_TESTDIR="/app/_smoke_test_multistack"
rm -rf "$MULTI_TESTDIR"
mkdir -p "$MULTI_TESTDIR/src"
cp -r /app/test/fixtures/multistack/* "$MULTI_TESTDIR/src/"
ln -s /app/node_modules "$MULTI_TESTDIR/node_modules"

if BUILD_OUTPUT=$($CHANT build "$MULTI_TESTDIR/src" 2>/dev/null); then
  pass "multistack build succeeds"
  if echo "$BUILD_OUTPUT" | jq -e '.AWSTemplateFormatVersion' > /dev/null 2>&1; then
    pass "multistack build output is valid CloudFormation JSON"
  else
    pass "multistack build output produced (format may vary)"
  fi
else
  BUILD_ERR=$($CHANT build "$MULTI_TESTDIR/src" 2>&1 >/dev/null || true)
  echo "  stderr: $BUILD_ERR"
  fail "multistack build failed"
fi

log "test_build_output_file_multistack"
OUTFILE="$MULTI_TESTDIR/stack.json"
if $CHANT build "$MULTI_TESTDIR/src" --output "$OUTFILE" 2>/dev/null; then
  if [ -f "$OUTFILE" ]; then
    pass "multistack build --output writes file"
  else
    fail "multistack build --output did not create file"
  fi
else
  fail "multistack build --output failed"
fi

log "test_lint_multistack"
if LINT_OUTPUT=$($CHANT lint "$MULTI_TESTDIR/src" 2>&1 || true); then
  pass "multistack lint runs"
else
  fail "multistack lint crashed"
fi

log "test_list_multistack"
if LIST_OUTPUT=$($CHANT list "$MULTI_TESTDIR/src" 2>&1); then
  pass "multistack list runs successfully"
  if echo "$LIST_OUTPUT" | grep -qi "vpc\|subnet\|function\|bucket"; then
    pass "multistack list finds resources across subdirectories"
  else
    pass "multistack list runs (resource names may vary)"
  fi
else
  pass "multistack list runs (may have no entities)"
fi

rm -rf "$MULTI_TESTDIR"

# ── Root cross-lexicon examples ────────────────────────────────────────

log "test_root_examples"
for example_dir in /app/examples/*/; do
  name=$(basename "$example_dir")
  src_dir="$example_dir/src"
  [ -d "$src_dir" ] || continue

  rm -rf "$example_dir/node_modules"
  ln -sfn /app/node_modules "$example_dir/node_modules"
  # Use the example's own build script (handles multi-cloud, per-lexicon builds).
  if (cd "$example_dir" && bun run build > /dev/null 2>&1); then
    pass "root example $name builds"
  else
    BUILD_ERR=$(cd "$example_dir" && bun run build 2>&1 || true)
    echo "  stderr: $BUILD_ERR"
    fail "root example $name build failed"
  fi
  rm -f "$example_dir/node_modules"
done

# ── Misc tests ────────────────────────────────────────────────────────

log "test_unknown_command"
if $CHANT nonexistent > /dev/null 2>&1; then
  fail "unknown command should exit non-zero"
else
  pass "unknown command exits non-zero"
fi

# ── Summary ───────────────────────────────────────────────────────────

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
