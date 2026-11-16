#!/usr/bin/env bash
# Pack chant's npm packages at a release's label, for `chant release publish`
# (#4040). Two forms:
#
#   bash scripts/release-pack.sh <member> <label> [--train <id|digest>]
#   bash scripts/release-pack.sh <version>
#
# The first packs one release member (#5135, #5132 decisions 2 and 3): the
# package its outer member owns (`lexicon-helm` -> lexicons/helm), with
# .version set to <label>. With --train, each @intentius/* dependency, peer
# and optional range is set to ^<that dependency's label in the train>, read
# from `chant workspace train list npm --json` in release/; the train must pin
# <member> at <label> and pin every @intentius/* package the member names.
# Without --train the ranges stay as committed. The package's workspace
# dependencies, direct or not, run their prepack first, core first, since its
# prepack compiles against their generated output. The tarball goes to
# .release/packs/<dir with / as _>.tgz, the path release/<member>/chant.config.ts
# names, next to any other member's.
#
# The second is the lockstep release: every package at <version>
# (release_apply_version), packed in publish-packages.sh's dependency layers.
#
# A release cut with `chant release cut --at` makes no version-bump commit, so
# the package.json files at the release's commit carry an older version. Both
# forms put the package.json files (and package-lock.json) back after packing.
# The publish refuses a checkout with changed files, and .release/ is ignored
# by git. RELEASE_CHANT overrides the chant command that reads the train.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
source scripts/release-lib.sh

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "release-pack: the working tree has changes; pack from a clean checkout of the release's commit" >&2
  exit 1
fi

if [ "$#" -ge 2 ]; then
  member="$1" label="$2" train=""
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --train) train="${2:?release-pack: --train needs a train id or digest}"; shift 2 ;;
      *) echo "release-pack: unknown argument $1" >&2; exit 2 ;;
    esac
  done
  [[ "$label" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release-pack: $label is not a version" >&2; exit 2; }
  dir=$(release_member_dir "$member")
  file="$dir/package.json"
  [ -f "$file" ] || { echo "release-pack: $file does not exist" >&2; exit 1; }
  [ "$(jq -r '.private // false' "$file")" = "true" ] && { echo "release-pack: $dir is private, so it is not published" >&2; exit 1; }

  # Package name -> label, for every member the train pins.
  labels='{}'
  if [ -n "$train" ]; then
    chant="${RELEASE_CHANT:-npx tsx $PWD/packages/core/src/cli/main.ts}"
    trains=$(cd release && $chant workspace train list npm --json)
    pins=$(jq -c --arg t "$train" '[.trains[] | select(.id == $t or .trainDigest == $t)] | last | if . == null then null else [.members[] | {member, label}] end' <<<"$trains")
    [ "$pins" != null ] || { echo "release-pack: no release train $train for npm" >&2; exit 1; }
    pinned=$(jq -r --arg m "$member" '.[] | select(.member == $m) | .label // "none"' <<<"$pins")
    if [ "$pinned" != "$label" ]; then
      echo "release-pack: train $train pins $member at ${pinned:-no release}, not $label" >&2
      exit 1
    fi
    while IFS=$'\t' read -r m l; do
      [ "$l" = null ] && continue
      d=$(release_member_dir "$m") || continue
      [ -f "$d/package.json" ] || continue
      labels=$(jq -c --arg n "$(jq -r .name "$d/package.json")" --arg l "$l" '. + {($n): $l}' <<<"$labels")
    done < <(jq -r '.[] | [.member, (.label // "null")] | @tsv' <<<"$pins")
  fi

  trap 'git checkout --quiet -- "$file"' EXIT
  if ! stamped=$(jq --arg v "$label" --argjson labels "$labels" --argjson train "$([ -n "$train" ] && echo true || echo false)" '
    def stamp($kind):
      if .[$kind] then .[$kind] |= with_entries(
        if (.key | startswith("@intentius/")) and .value != "*" then
          if $labels[.key] then .value = "^" + $labels[.key]
          elif $train then error("the train pins no release of " + .key)
          else . end
        else . end)
      else . end;
    .version = $v | stamp("dependencies") | stamp("peerDependencies") | stamp("optionalDependencies")
  ' "$file"); then
    echo "release-pack: $member: cannot stamp $file from train $train" >&2
    exit 1
  fi
  printf '%s\n' "$stamped" > "$file"
  # Core's tarball carries NEXT_RELEASE and its floors (#4480); its label is
  # the stamp that lets NEXT_RELEASE pass. A lexicon's floors are literals of
  # its own version (#5138) and are checked on every commit.
  if [ "$member" = core ]; then
    npx tsx scripts/release-floors.ts --npm
  fi

  # The publishable workspace packages <dir> depends on, directly or not, in
  # dependency order.
  ws=()
  for d in packages/*/ lexicons/*/; do ws+=("${d%/}"); done
  mapfile -t deps < <(node -e '
    const fs = require("fs");
    const path = require("path");
    const [target, ...dirs] = process.argv.slice(1);
    const pkg = new Map(), owner = new Map();
    for (const d of dirs) {
      const f = path.join(d, "package.json");
      if (!fs.existsSync(f)) continue;
      const p = JSON.parse(fs.readFileSync(f, "utf8"));
      if (p.private) continue;
      pkg.set(d, p);
      owner.set(p.name, d);
    }
    const needs = (d) => Object.keys({ ...pkg.get(d).dependencies, ...pkg.get(d).peerDependencies, ...pkg.get(d).optionalDependencies })
      .map((n) => owner.get(n)).filter((x) => x && x !== d).sort();
    const out = [], seen = new Set();
    const visit = (d) => { for (const x of needs(d)) if (!seen.has(x)) { seen.add(x); visit(x); out.push(x); } };
    visit(target);
    console.log(out.join("\n"));
  ' "$dir" "${ws[@]}")
  for d in "${deps[@]}"; do
    [ -n "$d" ] || continue
    echo "release-pack: prepack $d, which $dir builds against"
    (cd "$d" && npm run prepack)
  done

  slug="${dir//\//_}"
  work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chant-release-pack.XXXXXX")
  (cd "$dir" && npm pack --pack-destination "$work")
  tgz=$(find "$work" -maxdepth 1 -name '*.tgz' | head -1)
  [ -n "$tgz" ] || { echo "release-pack: npm pack wrote no tarball for $dir" >&2; exit 1; }
  mkdir -p .release/packs
  mv -f "$tgz" ".release/packs/$slug.tgz"
  echo "packed $(jq -r .name "$file")@$label in .release/packs/$slug.tgz"
  exit 0
fi

version="${1:?usage: release-pack.sh <member> <label> [--train <id>] | release-pack.sh <version>}"
bump_files=(packages/core/package.json packages/k8s-client/package.json lexicons/*/package.json)
restore() { git checkout --quiet -- "${bump_files[@]}" package-lock.json; }
trap restore EXIT
release_apply_version "$version"
# Every contract floor names a released version or this one (#4480). The
# stamp above is what lets NEXT_RELEASE pass at the release's own label.
# --npm: a CI checkout may lack a tag the maintainer's checkout has (#4503),
# and npm is what says a version was published.
npx tsx scripts/release-floors.ts --npm

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chant-release-pack.XXXXXX")
DRY_RUN=1 PACK_ALL=1 CHANT_PUBLISH_WORK="$work" bash scripts/publish-packages.sh

rm -rf .release/packs
mkdir -p .release/packs
missing=0
for dir in packages/*/ lexicons/*/; do
  dir="${dir%/}"
  [ -f "$dir/package.json" ] || continue
  [ "$(jq -r '.private // false' "$dir/package.json")" = "true" ] && continue
  slug="${dir//\//_}"
  tgz=$(find "$work/tgz/$slug" -maxdepth 1 -name '*.tgz' 2>/dev/null | head -1)
  if [ -z "$tgz" ]; then
    echo "release-pack: no tarball for $dir" >&2
    missing=1
    continue
  fi
  cp "$tgz" ".release/packs/$slug.tgz"
done
rm -rf "$work"
[ "$missing" = 0 ] || exit 1
echo "packed $(find .release/packs -name '*.tgz' | wc -l | tr -d ' ') packages at $version in .release/packs"
