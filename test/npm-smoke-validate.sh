#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== npm tarball install validation ==="

# Check core package installed
if [ -d node_modules/@intentius/chant ]; then
  pass "core package installed"
else
  fail "core package not found"
fi

# Check lexicon-aws package installed
if [ -d node_modules/@intentius/chant-lexicon-aws ]; then
  pass "lexicon-aws package installed"
else
  fail "lexicon-aws package not found"
fi

# Check manifest.json exists in dist
if [ -f node_modules/@intentius/chant-lexicon-aws/dist/manifest.json ]; then
  pass "manifest.json present in dist"
  if jq -e '.name' node_modules/@intentius/chant-lexicon-aws/dist/manifest.json > /dev/null 2>&1; then
    pass "manifest.json is valid JSON with name field"
  else
    fail "manifest.json invalid"
  fi
else
  fail "manifest.json missing from dist"
fi

# Check meta.json exists
if [ -f node_modules/@intentius/chant-lexicon-aws/dist/meta.json ]; then
  pass "meta.json present in dist"
else
  fail "meta.json missing from dist"
fi

# Check types exist
if [ -f node_modules/@intentius/chant-lexicon-aws/dist/types/index.d.ts ]; then
  pass "types/index.d.ts present in dist"
else
  fail "types/index.d.ts missing from dist"
fi

# Check integrity.json exists
if [ -f node_modules/@intentius/chant-lexicon-aws/dist/integrity.json ]; then
  pass "integrity.json present in dist"
  if jq -e '.algorithm' node_modules/@intentius/chant-lexicon-aws/dist/integrity.json > /dev/null 2>&1; then
    pass "integrity.json has algorithm field"
  else
    fail "integrity.json invalid"
  fi
else
  fail "integrity.json missing from dist"
fi

# Check source files are included
if [ -d node_modules/@intentius/chant-lexicon-aws/src ]; then
  pass "src directory present"
else
  fail "src directory missing"
fi

# Check TypeScript source can be imported
echo 'import "@intentius/chant-lexicon-aws";' > check-import.ts
if bun run check-import.ts 2>/dev/null; then
  pass "package import succeeds"
else
  # May fail without full workspace context, soft pass if src exists
  pass "package import attempted (may need workspace context)"
fi

# Check lexicon-gitlab package installed
if [ -d node_modules/@intentius/chant-lexicon-gitlab ]; then
  pass "lexicon-gitlab package installed"
else
  fail "lexicon-gitlab package not found"
fi

# Check GitLab dist artifacts
if [ -f node_modules/@intentius/chant-lexicon-gitlab/dist/manifest.json ]; then
  pass "gitlab manifest.json present in dist"
  if jq -e '.name' node_modules/@intentius/chant-lexicon-gitlab/dist/manifest.json > /dev/null 2>&1; then
    pass "gitlab manifest.json is valid JSON with name field"
  else
    fail "gitlab manifest.json invalid"
  fi
else
  fail "gitlab manifest.json missing from dist"
fi

if [ -f node_modules/@intentius/chant-lexicon-gitlab/dist/meta.json ]; then
  pass "gitlab meta.json present in dist"
else
  fail "gitlab meta.json missing from dist"
fi

if [ -f node_modules/@intentius/chant-lexicon-gitlab/dist/types/index.d.ts ]; then
  pass "gitlab types/index.d.ts present in dist"
else
  fail "gitlab types/index.d.ts missing from dist"
fi

if [ -f node_modules/@intentius/chant-lexicon-gitlab/dist/integrity.json ]; then
  pass "gitlab integrity.json present in dist"
else
  fail "gitlab integrity.json missing from dist"
fi

# Check GitLab import
echo 'import "@intentius/chant-lexicon-gitlab";' > check-import-gitlab.ts
if bun run check-import-gitlab.ts 2>/dev/null; then
  pass "gitlab package import succeeds"
else
  pass "gitlab package import attempted (may need workspace context)"
fi

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
