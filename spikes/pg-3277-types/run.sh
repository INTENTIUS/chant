#!/usr/bin/env bash
# Usage: run.sh <outroot>   (hold a docker slot: .docker-slot.sh <branch> -- ./run.sh <outroot>)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); out=${1:-$here/out}
while read -r tag digest; do
  node "$here/generate.mjs" "$tag" "$digest" "$out/$tag"
done <<LIST
14.24 sha256:c2427de38f998489d36de7ca3553db2134872c400f2b08be4b824e5c50e4d619
15.19 sha256:724292da1f2e50bdccfc3302ce75bbba7f4a6076701b588cc795fcac65683550
16.15 sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54
17.11 sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f
18.6 sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722
19beta4 sha256:d4afb1c70ecbcc4d87b8f7e86750a1a9ba04ddf830dbd27600ce14e5220077f6
LIST
# determinism: second and third reads at the pin, the third with 2 cpus
node "$here/generate.mjs" 18.6 sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722 "$out/18.6-run2"
node "$here/generate.mjs" 18.6 sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722 "$out/18.6-cpus2" --cpus=2
(cd "$out" && shasum -a 256 18.6*/postgres-catalog.json 18.6*/postgres-types.ts)
