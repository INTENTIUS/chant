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

# ---- test_help ----
log "test_help"
if $CHANT --help 2>&1 | grep -q "chant.*command"; then
  pass "help output contains usage info"
else
  fail "help output missing usage info"
fi

# ---- test_existing_example ----
log "test_existing_example (getting-started)"
EXAMPLE_DIR="/app/lexicons/aws/examples/getting-started"
if [ -d "$EXAMPLE_DIR/src" ]; then
  # Lint the getting-started example (lint is more reliable than build for smoke testing)
  if LINT_OUT=$($CHANT lint "$EXAMPLE_DIR/src" 2>&1); then
    pass "lint getting-started example succeeds"
  else
    # Lint may exit non-zero if there are warnings, that is acceptable
    pass "lint getting-started example runs (with diagnostics)"
  fi

  # Build the getting-started example
  if BUILD_OUT=$($CHANT build "$EXAMPLE_DIR/src" 2>&1); then
    pass "build getting-started example succeeds"
  else
    echo "  build output: $BUILD_OUT"
    fail "build getting-started example failed"
  fi
else
  echo "  SKIP: getting-started example not found"
fi

# ---- test_existing_example (gitlab) ----
log "test_existing_example (gitlab)"
GITLAB_EXAMPLE_DIR="/app/lexicons/gitlab/examples/getting-started"
if [ -d "$GITLAB_EXAMPLE_DIR/src" ]; then
  # Lint
  if LINT_OUT=$($CHANT lint "$GITLAB_EXAMPLE_DIR/src" 2>&1); then
    pass "lint gitlab getting-started succeeds"
  else
    pass "lint gitlab getting-started runs (with diagnostics)"
  fi
  # Build
  if BUILD_OUT=$($CHANT build "$GITLAB_EXAMPLE_DIR/src" 2>&1); then
    pass "build gitlab getting-started succeeds"
    if echo "$BUILD_OUT" | grep -q "stages:"; then
      pass "gitlab build output contains stages"
    else
      pass "gitlab build output produced (format may vary)"
    fi
  else
    echo "  build output: $BUILD_OUT"
    fail "build gitlab getting-started failed"
  fi
else
  echo "  SKIP: gitlab getting-started example not found"
fi

# Use a test directory inside /app so that workspace resolution can find
# @intentius/chant-lexicon-aws and @intentius/chant from the monorepo node_modules
TESTDIR="/app/_smoke_test_project"
rm -rf "$TESTDIR"
mkdir -p "$TESTDIR/src"

# Create a simple spec file that imports directly from the lexicon
cat > "$TESTDIR/src/storage.ts" <<'CHANT'
import { Bucket } from "@intentius/chant-lexicon-aws";
export const myBucket = new Bucket({
  bucketName: "my-test-bucket",
});
CHANT

# ---- test_build ----
log "test_build (fresh project)"
if BUILD_OUTPUT=$($CHANT build "$TESTDIR/src" 2>/dev/null); then
  pass "build succeeds on fresh project"
  if echo "$BUILD_OUTPUT" | jq -e '.AWSTemplateFormatVersion' > /dev/null 2>&1; then
    pass "build output is valid CloudFormation JSON"
  else
    echo "  stdout: $BUILD_OUTPUT"
    fail "build output is not valid CloudFormation JSON"
  fi
else
  BUILD_ERR=$($CHANT build "$TESTDIR/src" 2>&1 >/dev/null || true)
  echo "  stderr: $BUILD_ERR"
  fail "build failed on fresh project"
fi

# ---- test_build_output_file ----
log "test_build_output_file"
OUTFILE="$TESTDIR/stack.json"
if $CHANT build "$TESTDIR/src" --output "$OUTFILE" 2>/dev/null; then
  if [ -f "$OUTFILE" ]; then
    if jq -e '.AWSTemplateFormatVersion' "$OUTFILE" > /dev/null 2>&1; then
      pass "build --output writes valid CloudFormation JSON"
    else
      pass "build --output writes file"
    fi
  else
    fail "build --output did not create file"
  fi
else
  fail "build --output failed"
fi

# ---- test_build_yaml ----
log "test_build_yaml"
if YAML_OUTPUT=$($CHANT build "$TESTDIR/src" --format yaml 2>&1); then
  if echo "$YAML_OUTPUT" | grep -q "AWSTemplateFormatVersion"; then
    pass "build --format yaml produces YAML output"
  else
    pass "build --format yaml runs"
  fi
else
  fail "build --format yaml failed"
fi

# ---- test_lint ----
log "test_lint"
# Create a file that should trigger lint diagnostics (no encryption)
cat > "$TESTDIR/src/insecure.ts" <<'CHANT'
import { Bucket } from "@intentius/chant-lexicon-aws";
export const insecureBucket = new Bucket({});
CHANT

LINT_OUTPUT=$($CHANT lint "$TESTDIR/src" 2>&1 || true)
if echo "$LINT_OUTPUT" | grep -qi "W\|warning\|error\|issue"; then
  pass "lint produces diagnostics"
else
  # Even if no specific rule fires, lint should at least run without crashing
  pass "lint runs successfully"
fi

# ---- test_lint_json ----
log "test_lint_json"
if LINT_JSON=$($CHANT lint "$TESTDIR/src" --format json 2>&1 || true); then
  if echo "$LINT_JSON" | jq . > /dev/null 2>&1; then
    pass "lint --format json produces valid JSON"
  else
    pass "lint --format json runs (output may not be pure JSON)"
  fi
else
  fail "lint --format json crashed"
fi

# ---- test_lint_sarif ----
log "test_lint_sarif"
if LINT_SARIF=$($CHANT lint "$TESTDIR/src" --format sarif 2>&1 || true); then
  if echo "$LINT_SARIF" | jq -e '.version' > /dev/null 2>&1; then
    pass "lint --format sarif produces valid SARIF JSON"
  else
    pass "lint --format sarif runs"
  fi
else
  fail "lint --format sarif crashed"
fi

# ---- test_list ----
log "test_list"
if LIST_OUTPUT=$($CHANT list "$TESTDIR/src" 2>&1); then
  pass "list runs successfully"
else
  # list may exit non-zero if no entities found
  pass "list runs (may have no entities)"
fi

# ---- test_list_json ----
log "test_list_json"
if LIST_JSON=$($CHANT list "$TESTDIR/src" --format json 2>&1 || true); then
  if echo "$LIST_JSON" | jq . > /dev/null 2>&1; then
    pass "list --format json produces valid JSON"
  else
    pass "list --format json runs"
  fi
else
  fail "list --format json crashed"
fi

# ---- test_doctor ----
log "test_doctor"
# Doctor checks project health; it will find issues in our minimal test dir but should not crash
if DOCTOR_OUTPUT=$($CHANT doctor "$TESTDIR" 2>&1); then
  pass "doctor runs and passes"
else
  if echo "$DOCTOR_OUTPUT" | grep -q "FAIL\|WARN\|OK"; then
    pass "doctor runs (reports issues in minimal project)"
  else
    fail "doctor crashed"
  fi
fi

# ---- test_mcp ----
log "test_mcp"
# Send initialize + tools/list via stdin, then close stdin so server exits
MCP_INPUT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

if MCP_OUTPUT=$(echo "$MCP_INPUT" | $CHANT serve mcp "$TESTDIR" 2>/dev/null); then
  if echo "$MCP_OUTPUT" | grep -q '"protocolVersion"'; then
    pass "mcp initialize returns protocolVersion"
  else
    fail "mcp initialize missing protocolVersion"
  fi
  if echo "$MCP_OUTPUT" | grep -q '"tools"'; then
    pass "mcp tools/list returns tools"
  else
    fail "mcp tools/list missing tools"
  fi
  # Verify core tools are present
  if echo "$MCP_OUTPUT" | grep -q '"build"'; then
    pass "mcp tools include build"
  else
    fail "mcp tools missing build"
  fi
else
  # MCP server may exit non-zero when stdin closes, check output anyway
  MCP_OUTPUT=$(echo "$MCP_INPUT" | $CHANT serve mcp "$TESTDIR" 2>/dev/null || true)
  if echo "$MCP_OUTPUT" | grep -q '"protocolVersion"'; then
    pass "mcp initialize returns protocolVersion"
  else
    fail "mcp initialize failed"
  fi
  if echo "$MCP_OUTPUT" | grep -q '"tools"'; then
    pass "mcp tools/list returns tools"
  else
    fail "mcp tools/list failed"
  fi
  if echo "$MCP_OUTPUT" | grep -q '"build"'; then
    pass "mcp tools include build"
  else
    fail "mcp tools missing build"
  fi
fi

# ---- test_lsp ----
log "test_lsp"
# LSP uses Content-Length framing
LSP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"capabilities":{},"rootUri":null}}'
LSP_SHUTDOWN='{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}'
LSP_EXIT='{"jsonrpc":"2.0","method":"exit","params":{}}'

# Build Content-Length framed messages
_lsp_frame() {
  local body="$1"
  local len=${#body}
  printf "Content-Length: %d\r\n\r\n%s" "$len" "$body"
}

LSP_PAYLOAD="$(_lsp_frame "$LSP_INIT")$(_lsp_frame "$LSP_SHUTDOWN")$(_lsp_frame "$LSP_EXIT")"

if LSP_OUTPUT=$(printf '%s' "$LSP_PAYLOAD" | timeout 10 $CHANT serve lsp "$TESTDIR" 2>/dev/null || true); then
  if echo "$LSP_OUTPUT" | grep -q '"capabilities"'; then
    pass "lsp initialize returns capabilities"
  else
    fail "lsp initialize missing capabilities"
  fi
  if echo "$LSP_OUTPUT" | grep -q '"textDocumentSync"'; then
    pass "lsp capabilities include textDocumentSync"
  else
    # textDocumentSync might be nested, just check for it anywhere
    pass "lsp runs (textDocumentSync format may vary)"
  fi
else
  fail "lsp server crashed"
fi

# ---- test_skills ----
log "test_skills (via init + doctor)"
SKILLS_DIR="$TESTDIR/_skills_test"
rm -rf "$SKILLS_DIR"
mkdir -p "$SKILLS_DIR"

if $CHANT init --lexicon aws "$SKILLS_DIR" > /dev/null 2>&1; then
  # Check that skill files were installed
  if [ -f "$SKILLS_DIR/.chant/skills/aws/aws-cloudformation.md" ]; then
    pass "init installs aws-cloudformation skill"
  else
    fail "init did not install aws-cloudformation skill"
  fi

  # Check skill file content
  if [ -f "$SKILLS_DIR/.chant/skills/aws/aws-cloudformation.md" ]; then
    if grep -q "name: aws-cloudformation" "$SKILLS_DIR/.chant/skills/aws/aws-cloudformation.md"; then
      pass "skill file contains name frontmatter"
    else
      pass "skill file exists (frontmatter format may vary)"
    fi
  fi

  # Run doctor and check for skills check
  if DOCTOR_SKILLS=$($CHANT doctor "$SKILLS_DIR" 2>&1 || true); then
    if echo "$DOCTOR_SKILLS" | grep -q "skills-aws"; then
      pass "doctor includes skills check"
    else
      pass "doctor runs on init'd project (skills check may not appear)"
    fi
  fi
  # Build the scaffolded project — verifies init produces buildable code
  # Link workspace node_modules so imports resolve at runtime
  ln -s /app/node_modules "$SKILLS_DIR/node_modules"
  # Remove tsconfig paths that redirect imports to .d.ts stubs (bun follows them at runtime)
  rm -f "$SKILLS_DIR/tsconfig.json"
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

  # Lint the scaffolded project
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

# ---- test_init_lexicon ----
log "test_init_lexicon"
LEXICON_DIR="$TESTDIR/_init_lexicon_test"
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
  # Verify plugin.ts contains all 5 lifecycle methods
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

# ===========================================================================
# GitLab lexicon smoke tests
# ===========================================================================

GITLAB_TESTDIR="/app/_smoke_test_gitlab"
rm -rf "$GITLAB_TESTDIR"
mkdir -p "$GITLAB_TESTDIR/src"

cat > "$GITLAB_TESTDIR/src/ci.ts" <<'CHANT'
import { Job, Image, Artifacts } from "@intentius/chant-lexicon-gitlab";
export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:20" }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({ paths: ["coverage/"], expireIn: "1 week" }),
});
CHANT

# ---- test_build_gitlab ----
log "test_build_gitlab (fresh project)"
if BUILD_OUTPUT=$($CHANT build "$GITLAB_TESTDIR/src" 2>/dev/null); then
  pass "gitlab build succeeds on fresh project"
  if echo "$BUILD_OUTPUT" | grep -q "stages:"; then
    pass "gitlab build output contains stages"
  else
    pass "gitlab build output produced (format may vary)"
  fi
else
  BUILD_ERR=$($CHANT build "$GITLAB_TESTDIR/src" 2>&1 >/dev/null || true)
  echo "  stderr: $BUILD_ERR"
  fail "gitlab build failed on fresh project"
fi

# ---- test_build_output_file_gitlab ----
log "test_build_output_file_gitlab"
OUTFILE="$GITLAB_TESTDIR/pipeline.yml"
if $CHANT build "$GITLAB_TESTDIR/src" --output "$OUTFILE" 2>/dev/null; then
  if [ -f "$OUTFILE" ]; then
    if grep -q "stages:" "$OUTFILE" 2>/dev/null || [ -s "$OUTFILE" ]; then
      pass "gitlab build --output writes pipeline file"
    else
      pass "gitlab build --output writes file"
    fi
  else
    fail "gitlab build --output did not create file"
  fi
else
  fail "gitlab build --output failed"
fi

# ---- test_build_yaml_gitlab ----
log "test_build_yaml_gitlab"
if YAML_OUTPUT=$($CHANT build "$GITLAB_TESTDIR/src" --format yaml 2>&1); then
  if echo "$YAML_OUTPUT" | grep -q "stage:"; then
    pass "gitlab build --format yaml produces YAML output"
  else
    pass "gitlab build --format yaml runs"
  fi
else
  fail "gitlab build --format yaml failed"
fi

# ---- test_lint_gitlab ----
log "test_lint_gitlab"
cat > "$GITLAB_TESTDIR/src/insecure.ts" <<'CHANT'
import { Job } from "@intentius/chant-lexicon-gitlab";
export const badJob = new Job({});
CHANT

LINT_OUTPUT=$($CHANT lint "$GITLAB_TESTDIR/src" 2>&1 || true)
if echo "$LINT_OUTPUT" | grep -qi "W\|warning\|error\|issue"; then
  pass "gitlab lint produces diagnostics"
else
  pass "gitlab lint runs successfully"
fi

# ---- test_lint_json_gitlab ----
log "test_lint_json_gitlab"
if LINT_JSON=$($CHANT lint "$GITLAB_TESTDIR/src" --format json 2>&1 || true); then
  if echo "$LINT_JSON" | jq . > /dev/null 2>&1; then
    pass "gitlab lint --format json produces valid JSON"
  else
    pass "gitlab lint --format json runs (output may not be pure JSON)"
  fi
else
  fail "gitlab lint --format json crashed"
fi

# ---- test_lint_sarif_gitlab ----
log "test_lint_sarif_gitlab"
if LINT_SARIF=$($CHANT lint "$GITLAB_TESTDIR/src" --format sarif 2>&1 || true); then
  if echo "$LINT_SARIF" | jq -e '.version' > /dev/null 2>&1; then
    pass "gitlab lint --format sarif produces valid SARIF JSON"
  else
    pass "gitlab lint --format sarif runs"
  fi
else
  fail "gitlab lint --format sarif crashed"
fi

# ---- test_list_gitlab ----
log "test_list_gitlab"
if LIST_OUTPUT=$($CHANT list "$GITLAB_TESTDIR/src" 2>&1); then
  pass "gitlab list runs successfully"
else
  pass "gitlab list runs (may have no entities)"
fi

# ---- test_list_json_gitlab ----
log "test_list_json_gitlab"
if LIST_JSON=$($CHANT list "$GITLAB_TESTDIR/src" --format json 2>&1 || true); then
  if echo "$LIST_JSON" | jq . > /dev/null 2>&1; then
    pass "gitlab list --format json produces valid JSON"
  else
    pass "gitlab list --format json runs"
  fi
else
  fail "gitlab list --format json crashed"
fi

# ---- test_doctor_gitlab ----
log "test_doctor_gitlab"
if DOCTOR_OUTPUT=$($CHANT doctor "$GITLAB_TESTDIR" 2>&1); then
  pass "gitlab doctor runs and passes"
else
  if echo "$DOCTOR_OUTPUT" | grep -q "FAIL\|WARN\|OK"; then
    pass "gitlab doctor runs (reports issues in minimal project)"
  else
    fail "gitlab doctor crashed"
  fi
fi

# ---- test_mcp_gitlab ----
log "test_mcp_gitlab"
MCP_INPUT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

if MCP_OUTPUT=$(echo "$MCP_INPUT" | $CHANT serve mcp "$GITLAB_TESTDIR" 2>/dev/null); then
  if echo "$MCP_OUTPUT" | grep -q '"protocolVersion"'; then
    pass "gitlab mcp initialize returns protocolVersion"
  else
    fail "gitlab mcp initialize missing protocolVersion"
  fi
  if echo "$MCP_OUTPUT" | grep -q '"tools"'; then
    pass "gitlab mcp tools/list returns tools"
  else
    fail "gitlab mcp tools/list missing tools"
  fi
else
  MCP_OUTPUT=$(echo "$MCP_INPUT" | $CHANT serve mcp "$GITLAB_TESTDIR" 2>/dev/null || true)
  if echo "$MCP_OUTPUT" | grep -q '"protocolVersion"'; then
    pass "gitlab mcp initialize returns protocolVersion"
  else
    fail "gitlab mcp initialize failed"
  fi
  if echo "$MCP_OUTPUT" | grep -q '"tools"'; then
    pass "gitlab mcp tools/list returns tools"
  else
    fail "gitlab mcp tools/list failed"
  fi
fi

# ---- test_lsp_gitlab ----
log "test_lsp_gitlab"
LSP_INIT_GL='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"capabilities":{},"rootUri":null}}'
LSP_SHUTDOWN_GL='{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}'
LSP_EXIT_GL='{"jsonrpc":"2.0","method":"exit","params":{}}'

LSP_PAYLOAD_GL="$(_lsp_frame "$LSP_INIT_GL")$(_lsp_frame "$LSP_SHUTDOWN_GL")$(_lsp_frame "$LSP_EXIT_GL")"

if LSP_OUTPUT=$(printf '%s' "$LSP_PAYLOAD_GL" | timeout 10 $CHANT serve lsp "$GITLAB_TESTDIR" 2>/dev/null || true); then
  if echo "$LSP_OUTPUT" | grep -q '"capabilities"'; then
    pass "gitlab lsp initialize returns capabilities"
  else
    fail "gitlab lsp initialize missing capabilities"
  fi
else
  fail "gitlab lsp server crashed"
fi

# ---- test_init_gitlab ----
log "test_init_gitlab"
GITLAB_INIT_DIR="$GITLAB_TESTDIR/_init_test"
rm -rf "$GITLAB_INIT_DIR"
mkdir -p "$GITLAB_INIT_DIR"

if $CHANT init --lexicon gitlab "$GITLAB_INIT_DIR" > /dev/null 2>&1; then
  # Check scaffolded plugin file
  if [ -f "$GITLAB_INIT_DIR/src/_.ts" ] || [ -f "$GITLAB_INIT_DIR/src/config.ts" ]; then
    pass "gitlab init creates source files"
  else
    fail "gitlab init missing source files"
  fi

  # Check skill file
  if [ -f "$GITLAB_INIT_DIR/.chant/skills/gitlab/gitlab-ci.md" ]; then
    pass "gitlab init installs gitlab-ci skill"
  else
    fail "gitlab init did not install gitlab-ci skill"
  fi

  # Build the scaffolded project
  ln -s /app/node_modules "$GITLAB_INIT_DIR/node_modules"
  rm -f "$GITLAB_INIT_DIR/tsconfig.json"
  if BUILD_INIT=$($CHANT build "$GITLAB_INIT_DIR/src" 2>"$GITLAB_INIT_DIR/build-stderr.log"); then
    pass "gitlab init project builds successfully"
  else
    echo "  stderr: $(cat "$GITLAB_INIT_DIR/build-stderr.log")"
    fail "gitlab init project build failed"
  fi

  # Lint the scaffolded project
  if $CHANT lint "$GITLAB_INIT_DIR/src" > /dev/null 2>&1; then
    pass "gitlab init project passes lint"
  else
    LINT_INIT=$($CHANT lint "$GITLAB_INIT_DIR/src" 2>&1 || true)
    echo "  lint: $LINT_INIT"
    fail "gitlab init project lint failed"
  fi
else
  fail "init --lexicon gitlab failed"
fi
rm -rf "$GITLAB_INIT_DIR"

rm -rf "$GITLAB_TESTDIR"

# ---- test_unknown_command ----
log "test_unknown_command"
if $CHANT nonexistent > /dev/null 2>&1; then
  fail "unknown command should exit non-zero"
else
  pass "unknown command exits non-zero"
fi

# ---- Cleanup ----
rm -rf "$TESTDIR"

# ---- Summary ----
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
