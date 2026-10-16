#!/usr/bin/env bash
# Writes chant's brand files into docs/public/brand and docs/public from the
# two grids in logo.py and mark.py. Run it after editing a grid and commit
# the output with the change.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pub="$here/../../public"
mkdir -p "$pub/brand"
# The site masks these over a colour token (styles/chant.css), so one file
# serves both themes and the fill here is only their alpha.
python3 "$here/logo.py" '#000' "$pub/brand/logo.svg"
python3 "$here/mark.py" '#000' "$pub/brand/mark.svg"
python3 "$here/logo.py" --favicon "$pub/favicon.svg"
python3 "$here/logo.py" --png "$pub/favicon-48.png"
