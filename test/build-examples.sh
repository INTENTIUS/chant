#!/usr/bin/env bash
set -euo pipefail

# Build all root examples inside the smoke container.
# Artifacts are written to each example's directory under /app/examples/.
# After this script, the caller copies /app/examples/*/{output files} to /output/.

PASS=0
FAIL=0

for example_dir in /app/examples/*/; do
  name=$(basename "$example_dir")
  [ -f "$example_dir/package.json" ] || continue

  echo "=== Building $name ==="
  rm -rf "$example_dir/node_modules"
  ln -sfn /app/node_modules "$example_dir/node_modules"
  mkdir -p "$example_dir/templates" 2>/dev/null || true

  if (cd "$example_dir" && bun run build 2>&1); then
    echo "  OK: $name"
    PASS=$((PASS + 1))
  else
    echo "  WARN: $name build had errors"
    FAIL=$((FAIL + 1))
  fi

  rm -f "$example_dir/node_modules"
done

echo ""
echo "Build results: $PASS passed, $FAIL failed"

# Copy artifacts to /output if it exists (for volume mount extraction)
if [ -d /output ]; then
  echo "Copying artifacts to /output..."
  for example_dir in /app/examples/*/; do
    name=$(basename "$example_dir")
    out="/output/$name"
    mkdir -p "$out"
    # Copy known artifact patterns
    [ -f "$example_dir/k8s.yaml" ]     && cp "$example_dir/k8s.yaml" "$out/"
    [ -f "$example_dir/flyway.toml" ]  && cp "$example_dir/flyway.toml" "$out/"
    [ -f "$example_dir/.gitlab-ci.yml" ] && cp "$example_dir/.gitlab-ci.yml" "$out/"
    [ -d "$example_dir/templates" ]    && cp -r "$example_dir/templates" "$out/" 2>/dev/null || true
    # Copy skills and README for agent context
    [ -d "$example_dir/.claude" ]      && cp -r "$example_dir/.claude" "$out/"
    [ -f "$example_dir/README.md" ]    && cp "$example_dir/README.md" "$out/"
    # Copy deploy scripts if they exist
    [ -d "$example_dir/scripts" ]      && cp -r "$example_dir/scripts" "$out/"
    [ -f "$example_dir/package.json" ] && cp "$example_dir/package.json" "$out/"
    [ -f "$example_dir/setup.sh" ]     && cp "$example_dir/setup.sh" "$out/"
    # Copy SQL migrations for flyway examples
    [ -d "$example_dir/sql" ]          && cp -r "$example_dir/sql" "$out/"
    # Copy .env.example for eks
    [ -f "$example_dir/.env.example" ] && cp "$example_dir/.env.example" "$out/"
  done
  echo "Done."
fi

[ "$FAIL" -eq 0 ] || exit 1
