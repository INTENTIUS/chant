#!/usr/bin/env bash
set -euo pipefail

# AWS CloudFormation samples roundtrip test
# Clones awslabs/aws-cloudformation-templates and runs parse+generate on each template.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CACHE_DIR="$ROOT_DIR/.cache"
REPO_DIR="$CACHE_DIR/aws-cloudformation-templates"
HELPER="$SCRIPT_DIR/roundtrip-helper.ts"

SKIP_CLONE=false
VERBOSE=false
FILTER_TEMPLATE=""
PASS_THRESHOLD=95

usage() {
  echo "Usage: $0 [--skip-clone] [--verbose] [--template NAME]"
  echo ""
  echo "  --skip-clone   Skip git clone if repo already exists"
  echo "  --verbose      Show per-template pass/fail output"
  echo "  --template NAME  Only test templates matching NAME"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-clone) SKIP_CLONE=true; shift ;;
    --verbose) VERBOSE=true; shift ;;
    --template) FILTER_TEMPLATE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# Clone or update the repo
if [[ "$SKIP_CLONE" == "false" ]] || [[ ! -d "$REPO_DIR" ]]; then
  echo "Cloning aws-cloudformation-templates..."
  mkdir -p "$CACHE_DIR"
  if [[ -d "$REPO_DIR" ]]; then
    rm -rf "$REPO_DIR"
  fi
  git clone --depth 1 https://github.com/awslabs/aws-cloudformation-templates.git "$REPO_DIR" 2>/dev/null
  echo "Clone complete."
else
  echo "Using cached repo at $REPO_DIR"
fi

# Exclusion patterns — templates that use features not supported by the parser:
# Rain DSL, CDK, macros, Fn::ForEach, custom resources with inline Lambda, etc.
EXCLUSIONS=(
  "rain/"
  "Rain"
  "cdk/"
  "macro"
  "Fn::ForEach"
  "fn-foreach"
  "custom_resource"
  "CustomResource"
  "cloudformation-guard"
  "stacksets"
  "StackSets"
  "nested"
  "module"
  "Module"
  "-pkg."
)

should_exclude() {
  local file="$1"
  for pattern in "${EXCLUSIONS[@]}"; do
    if [[ "$file" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

# Specific templates to ignore — known failures due to !Rain::Embed tags
# embedded in otherwise non-Rain files, or other unsupported constructs.
IGNORE_LIST=(
  "APIGateway/apigateway_lambda_integration.yaml"
  "AWSSupplyChain/SapPrivateLink/SapPrivateLink.yaml"
  "AWSSupplyChain/SapPrivateLink/SapPrivateLinkNoHostedZone.yaml"
  "CloudFormation/MacrosExamples/DateFunctions/date.yaml"
  "CloudFormation/MacrosExamples/PyPlate/python.yaml"
  "CloudFormation/MacrosExamples/StringFunctions/string.yaml"
  "CloudFormation/MacrosExamples/Count/event.json"
  "CloudFormation/MacrosExamples/Count/event_bad.json"
  "ElastiCache/Elasticache-snapshot.yaml"
  "IoT/amzn2-greengrass-cfn.yaml"
  "IoT/amzn2-greengrass-cfn.json"
  "Solutions/Gitea/Gitea.yaml"
  "Solutions/Gitea/Gitea.json"
  "Solutions/GitLab/GitLabServer.yaml"
  "Solutions/GitLab/GitLabServer.json"
  "Solutions/GitLabAndVSCode/GitLabAndVSCode.yaml"
  "Solutions/GitLabAndVSCode/GitLabAndVSCode.json"
  "Solutions/VSCode/VSCodeServer.yaml"
  "Solutions/VSCode/VSCodeServer.json"
)

should_ignore() {
  local rel="$1"
  for entry in "${IGNORE_LIST[@]}"; do
    if [[ "$rel" == "$entry" ]]; then
      return 0
    fi
  done
  return 1
}

# Discover templates into a temp file (avoids bash version issues with mapfile)
TEMPLATE_LIST=$(mktemp)
trap 'rm -f "$TEMPLATE_LIST"' EXIT
find "$REPO_DIR" -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" \) | sort > "$TEMPLATE_LIST"

total=0
pass=0
fail=0
skip=0

echo "Running roundtrip tests..."
echo ""

while IFS= read -r template; do
  rel="${template#$REPO_DIR/}"

  # Apply filter
  if [[ -n "$FILTER_TEMPLATE" ]] && [[ "$rel" != *"$FILTER_TEMPLATE"* ]]; then
    continue
  fi

  # Check exclusions
  if should_exclude "$rel"; then
    ((skip++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP: $rel"
    fi
    continue
  fi

  # Check ignore list
  if should_ignore "$rel"; then
    ((skip++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP (ignored): $rel"
    fi
    continue
  fi

  ((total++)) || true

  # Check if it's actually a CloudFormation template (must contain Resources or AWSTemplateFormatVersion)
  if ! grep -qE '(AWSTemplateFormatVersion|"Resources"|Resources:)' "$template" 2>/dev/null; then
    ((skip++)) || true
    ((total--)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "SKIP (not CF): $rel"
    fi
    continue
  fi

  export VERBOSE
  if bun run "$HELPER" "$template" 2>/dev/null; then
    ((pass++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "PASS: $rel"
    fi
  else
    ((fail++)) || true
    if [[ "$VERBOSE" == "true" ]]; then
      echo "FAIL: $rel"
    fi
  fi
done < "$TEMPLATE_LIST"

echo ""
echo "=== Results ==="
echo "Total:   $total"
echo "Pass:    $pass"
echo "Fail:    $fail"
echo "Skipped: $skip"

if [[ $total -gt 0 ]]; then
  rate=$(( (pass * 100) / total ))
  echo "Pass rate: ${rate}%"
  echo ""

  if [[ $rate -ge $PASS_THRESHOLD ]]; then
    echo "PASSED: ${rate}% >= ${PASS_THRESHOLD}% threshold"
    exit 0
  else
    echo "FAILED: ${rate}% < ${PASS_THRESHOLD}% threshold"
    exit 1
  fi
else
  echo "No templates found to test."
  exit 1
fi
