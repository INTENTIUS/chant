#!/usr/bin/env bash
# Generate SVGs from .dot source files for all docs sites.
# Output goes to public/diagrams/ inside each docs directory (gitignored).
set -euo pipefail

build_diagrams() {
  local src_dir="$1"
  local out_dir="$2"
  [ -d "$src_dir" ] || return 0
  local count=0
  mkdir -p "$out_dir"
  for f in "$src_dir"/*.dot; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .dot)
    dot -Tsvg -o "$out_dir/$name.svg" "$f"
    echo "  $f → $out_dir/$name.svg"
    count=$((count + 1))
  done
  # Hand-authored SVGs (e.g. Venn diagrams graphviz can't draw) are copied through as-is.
  for f in "$src_dir"/*.svg; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    cp "$f" "$out_dir/$name"
    echo "  $f → $out_dir/$name (copied)"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] && echo "  $count diagram(s) built in $out_dir"
}

echo "Building diagrams..."

# Main docs
build_diagrams docs/diagrams docs/public/diagrams

# Each lexicon that has a diagrams/ directory
for lexicon_docs in lexicons/*/docs; do
  build_diagrams "$lexicon_docs/diagrams" "$lexicon_docs/public/diagrams"
done

echo "Done."
