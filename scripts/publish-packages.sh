#!/usr/bin/env bash
# Publish every publishable workspace package, in dependency-safe order.
#
# This replaces the 14 hand-maintained publish steps that publish.yml used to
# carry. Two bugs came out of that shape and both turned the release pipeline
# red for days:
#
#   * #1177 added packages/k8s-client and #1253 added lexicons/fountain. Each
#     shipped a publish step but neither package ever got an npm
#     trusted-publisher record, so `npm publish` fell through to ENEEDAUTH.
#     Every publish run from chant-v0.33.0 onward failed, and both packages
#     stranded a version behind the rest of the release.
#   * Before the per-step `if: !cancelled()` guard, the first such failure
#     SKIPPED every package after it, half-publishing the release.
#
# Enumerating the workspace fixes the first failure mode structurally: a new
# non-private package is picked up with no workflow edit at all. The auth
# fallback below fixes the second: a package with no trusted-publisher record
# yet publishes with NPM_TOKEN rather than stranding everything behind it.
#
# Never stops on the first failure. Every package gets its attempt unless a
# workspace package it depends on failed, and the run exits non-zero at the end
# if anything failed. The skip-if-unchanged check makes re-running idempotent,
# so a partial release is recovered by re-running the workflow.
#
# Pack first, then publish (#3857). On chant-v0.124.7 (publish run
# 38189259355) this step took 2060s: about 7 minutes of prepack builds run one
# at a time inside each `npm publish`, and about 27 minutes in six serial waits
# (core, k8s-client, github, otel, prometheus, k8s), four of them exactly 300s.
# The waits came from #3842's check that a dependency's tarball answered 200
# before its dependents published. It requested the tarball URL straight after
# `npm publish`, the first request 404ed, and npm's CDN appears to cache that
# 404 for about 5 minutes, so the probe caused the delay it was waiting out.
# What #3842 needed was narrower: its ETARGET came from a packument that did
# not list the new core version yet. So the run now goes:
#
#   1. Pack. `npm pack` runs each prepack (generate, bundle, validate, build)
#      and leaves a tarball. Layer by layer, since a prepack compiles against
#      its dependencies' generated output; the packages in a layer pack in
#      parallel, PACK_JOBS at a time (default 4).
#   2. Publish the tarballs layer by layer, a layer's packages in parallel.
#      Before the next layer starts, wait until the registry metadata lists
#      every version it depends on (`wait_visible`). The wait never requests a
#      tarball URL.
#   3. Probe each published tarball once, at the end, and report the status
#      without failing the job.
#
# Publishing a tarball keeps provenance: npm signs the attestation over the
# tarball's digest and takes the build identity from the OIDC environment,
# whichever way the tarball was produced. It runs no lifecycle scripts, which
# is the point here, since pack already ran prepack.
#
# Knobs:
#   DRY_RUN=plan   print the layered plan and exit, building nothing
#   DRY_RUN=1      pack everything (real prepacks), print the plan, publish nothing
#   PACK_JOBS      parallel prepacks per layer (default 4)
#   WAIT_TIMEOUT   seconds to wait for a version's metadata (default 1800)
#   WAIT_INTERVAL  seconds between metadata polls (default 10)
set -uo pipefail

REGISTRY="https://registry.npmjs.org"
DRY_RUN="${DRY_RUN:-}"
PACK_JOBS="${PACK_JOBS:-4}"

# Every workspace directory that npm would actually publish, as tab-separated
# lines of `layer dir name version deps`, where deps is a comma-separated list
# of the publishable workspace dirs it depends on. Layer 0 depends on no
# workspace package; every other package sits one layer above its highest
# dependency. Sorting by layer gives an order where a package always follows
# the workspace packages it depends on. `private: true` packages
# (packages/test-utils) are skipped the same way npm would skip them.
#
# The order is derived, not listed. Each prepack both builds against and imports
# its workspace dependencies' *generated* output, so packing a dependent first
# fails on a module that does not exist yet. Directory order used to stand in
# for this, and it happened to be right until it was not: chant-v0.34.0
# stranded lexicon-forgejo (needs github's `src/generated/index`) and
# lexicon-helm (needs k8s's `dist/generated/index.d.ts`), because
# `forgejo` < `github` and `helm` < `k8s`. Any future lexicon that depends on
# an alphabetically later one would have done the same.
#
# Edges come from dependencies, peerDependencies and optionalDependencies.
# Optional counts: the k8s lexicon declares @intentius/chant-k8s-client optional
# (#1074), and npm tolerates an optional dependency that fails to resolve, so
# publishing the client after the lexicon degrades `chant lifecycle diff --live`
# to holes on a registry install rather than failing loudly.
publish_layers() {
  local dirs=()
  local dir
  for dir in packages/*/ lexicons/*/; do
    dir="${dir%/}"
    [ -f "$dir/package.json" ] && dirs+=("$dir")
  done

  node -e '
    const fs = require("fs");
    const dirs = process.argv.slice(1);

    const pkg = new Map();   // dir -> package.json
    const owner = new Map(); // package name -> dir
    for (const d of dirs) {
      const p = JSON.parse(fs.readFileSync(d + "/package.json", "utf8"));
      if (p.private) continue;
      pkg.set(d, p);
      owner.set(p.name, d);
    }

    // dir -> the publishable workspace dirs it must follow.
    const needs = new Map();
    for (const [d, p] of pkg) {
      const deps = Object.keys({
        ...p.dependencies,
        ...p.peerDependencies,
        ...p.optionalDependencies,
      });
      needs.set(d, [...new Set(deps.map((n) => owner.get(n)).filter((x) => x && x !== d))].sort());
    }

    // Kahn, one layer per round: everything whose dependencies are all in
    // earlier layers. Alphabetical within a layer, so the plan is stable and
    // reviewable rather than dependent on Map insertion.
    const layer = new Map();
    const left = new Set(pkg.keys());
    let n = 0;
    while (left.size) {
      let ready = [...left].filter((d) => !needs.get(d).some((x) => left.has(x))).sort();
      if (!ready.length) {
        // A cycle. Put the rest in one last layer rather than publishing
        // nothing; npm will say which package could not build.
        console.error("publish order: dependency cycle among " + [...left].sort().join(", "));
        ready = [...left].sort();
      }
      for (const d of ready) { layer.set(d, n); left.delete(d); }
      n++;
    }

    const out = [...layer.keys()].sort((a, b) => layer.get(a) - layer.get(b) || (a < b ? -1 : 1));
    for (const d of out) {
      const p = pkg.get(d);
      console.log([layer.get(d), d, p.name, p.version, needs.get(d).join(",")].join("\t"));
    }
  ' "${dirs[@]}"
}

# The publishable dirs that some other publishable package depends on, directly
# or transitively — the ones whose build output another package compiles
# against.
#
# Deliberately a static question about the graph rather than "does anything
# being published right now need it": answering that needs every package's live
# version before the first one is processed, and getting it wrong strands a
# release. The cost of being approximate is prepacking a dependency on a rerun
# where nothing turned out to need it. The cost of being exact and wrong is
# another half-published release.
depended_on_dirs() {
  local dirs=()
  local dir
  for dir in packages/*/ lexicons/*/; do
    dir="${dir%/}"
    [ -f "$dir/package.json" ] && dirs+=("$dir")
  done

  node -e '
    const fs = require("fs");
    const dirs = process.argv.slice(1);

    const pkg = new Map();
    const owner = new Map();
    for (const d of dirs) {
      const p = JSON.parse(fs.readFileSync(d + "/package.json", "utf8"));
      if (p.private) continue;
      pkg.set(d, p);
      owner.set(p.name, d);
    }

    const direct = (d) => {
      const p = pkg.get(d);
      return Object.keys({
        ...p.dependencies,
        ...p.peerDependencies,
        ...p.optionalDependencies,
      }).map((n) => owner.get(n)).filter((x) => x && x !== d);
    };

    const needed = new Set();
    const walk = (d) => {
      for (const dep of direct(d)) {
        if (needed.has(dep)) continue;
        needed.add(dep);
        walk(dep);
      }
    };
    for (const d of pkg.keys()) walk(d);
    console.log([...needed].sort().join("\n"));
  ' "${dirs[@]}"
}

# Ask the registry why it refused OIDC, and print its answer.
#
# npm's oidc helper is written never to throw: when the token exchange fails
# it logs at verbose level and returns undefined, so `npm publish` falls
# through to ordinary auth and reports a bare ENEEDAUTH. That single error
# covers two very different situations — no trusted-publisher record at all,
# versus a record that does not match this workflow's OIDC claims (wrong
# workflow filename, or an environment configured on npm that the job does
# not declare). Replaying the exchange ourselves is the only way to tell them
# apart without editing the workflow to run verbose.
#
# Prints the HTTP status and the registry's message. Never prints the GitHub
# id-token or the publish token a successful exchange returns.
oidc_reason() {
  local name="$1" idtok status escaped body_file
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "  OIDC was never attempted: this job has no id-token: write permission"
    return
  fi
  idtok=$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    -H "Accept: application/json" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npm:registry.npmjs.org" 2>/dev/null \
    | jq -r '.value // empty' 2>/dev/null)
  if [ -z "$idtok" ]; then
    echo "  OIDC unavailable: GitHub did not issue an id-token"
    return
  fi
  escaped=${name//\//%2f}
  body_file=$(mktemp)
  status=$(curl -sS -o "$body_file" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $idtok" \
    "$REGISTRY/-/npm/v1/oidc/token/exchange/package/$escaped" 2>/dev/null)
  # A successful exchange answers 201 Created, not 200 — checking for 200
  # alone reports a perfectly good trusted-publisher record as refused.
  if [ "${status:0:1}" = "2" ]; then
    echo "  registry ACCEPTED the OIDC exchange (HTTP $status) — the auth failure is not the record"
  else
    echo "  registry REFUSED the OIDC exchange: HTTP $status — $(jq -r '.message // .error // "no message"' "$body_file" 2>/dev/null || echo "unreadable body")"
  fi
  rm -f "$body_file"
}

# npm's own error lines, with the `npm notice` narration stripped. Deciding
# what a failure was from the full output misreads the notices — they mention
# provenance on every single run, successful or not.
npm_errors() {
  printf '%s' "$1" | grep '^npm error' || true
}

# Publish one packed tarball. Runs from the package's directory so npm reads
# the same config it would for a directory publish. Tries OIDC trusted
# publishing first (no .npmrc exists, so npm detects the absent auth plus the
# id-token environment and exchanges for a short-lived publish token). Falls
# back to NPM_TOKEN only when the registry says we are unauthenticated — a
# version conflict must not silently retry with a different credential.
publish_one() {
  local dir="$1" name="$2" tgz="$3" out rc npmrc

  out=$(cd "$dir" && npm publish "$tgz" --access public --provenance 2>&1)
  rc=$?
  printf '%s\n' "$out"
  [ $rc -eq 0 ] && return 0

  if ! printf '%s' "$out" | grep -qE 'ENEEDAUTH|E401|need auth'; then
    return $rc
  fi

  oidc_reason "$name"

  if [ -z "${NPM_TOKEN:-}" ]; then
    echo "  $name could not authenticate over OIDC and NPM_TOKEN is not set — cannot publish"
    return $rc
  fi

  # No trusted-publisher record for this package yet. Configure the token in a
  # throwaway userconfig rather than on the command line so it never lands in
  # the process table, and scope it to this one publish so the packages that
  # DO have a record keep using trusted publishing.
  echo "  $name: OIDC unavailable — retrying with NPM_TOKEN"
  npmrc=$(mktemp)
  chmod 600 "$npmrc"
  printf '%s/:_authToken=%s\n' "${REGISTRY#https:}" "$NPM_TOKEN" > "$npmrc"
  out=$(cd "$dir" && NPM_CONFIG_USERCONFIG="$npmrc" npm publish "$tgz" --access public --provenance 2>&1)
  rc=$?
  printf '%s\n' "$out"

  # Attestation is signed against the trusted-publisher identity, so a token
  # publish can be rejected for provenance alone. A package that ships without
  # an attestation beats a release that strands a package a version behind —
  # publish it unattested and say so loudly. Match only npm's *error* lines:
  # `npm notice` narrates provenance on every run, so scanning the whole
  # output retries pointlessly on unrelated failures.
  if [ $rc -ne 0 ] && npm_errors "$out" | grep -qiE 'provenance|attestation'; then
    echo "::warning::$name: provenance rejected on the token path — publishing without an attestation"
    out=$(cd "$dir" && NPM_CONFIG_USERCONFIG="$npmrc" npm publish "$tgz" --access public 2>&1)
    rc=$?
    printf '%s\n' "$out"
  fi
  rm -f "$npmrc"

  # An automation token bypasses 2FA; a classic publish or granular token does
  # not, and npm asks for an OTP no human is there to type. Name that
  # precisely — it is otherwise indistinguishable from a permissions problem.
  if [ $rc -ne 0 ] && npm_errors "$out" | grep -q 'EOTP'; then
    echo "::error::$name: NPM_TOKEN requires a one-time password, so it cannot publish from CI."
    echo "  Fix either side: add a trusted publisher for $name (INTENTIUS/chant, publish.yml)"
    echo "  at https://www.npmjs.com/package/$name/access, or replace the NPM_TOKEN secret"
    echo "  with an npm *automation* token, which bypasses 2FA."
  fi

  if [ $rc -eq 0 ]; then
    echo "  $name published with NPM_TOKEN. Add a trusted publisher for it at"
    echo "  https://www.npmjs.com/package/$name/access so the next release uses OIDC."
  fi
  return $rc
}

# Wait until the registry metadata lists a version this run just published.
#
# #3842: npm is eventually consistent across packages. After chant-v0.124.6 a
# lexicon version was visible before the core version it requires, and a fresh
# `npm install` failed with ETARGET on @intentius/chant@^0.124.6 for a few
# minutes. ETARGET means the packument did not list the version, so that is
# what this waits on, through both of the ways a client reads it: `npm view`
# (the full packument) and the abbreviated packument `npm install` fetches.
# `--prefer-online` matters: the skip check below already read this packument,
# and npm's local cache would otherwise serve that copy for its max-age (300s).
#
# It never requests the tarball URL. A request made before the CDN has the
# file 404s, and that 404 appears to stay cached for about 5 minutes (#3857).
#
# Polls every WAIT_INTERVAL seconds (default 10) up to WAIT_TIMEOUT seconds
# (default 1800).
wait_visible() {
  local name="$1" version="$2" waited=0 seen listed
  local interval="${WAIT_INTERVAL:-10}" limit="${WAIT_TIMEOUT:-1800}"
  local packument="$REGISTRY/${name//\//%2f}"
  while :; do
    seen=$(npm view --prefer-online "$name@$version" version 2>/dev/null || true)
    listed=$(curl -sfL -H 'Accept: application/vnd.npm.install-v1+json' "$packument" 2>/dev/null \
      | node -e '
          let s = "";
          process.stdin.on("data", (c) => (s += c)).on("end", () => {
            try { process.stdout.write(JSON.parse(s).versions?.[process.argv[1]] ? "yes" : "no"); }
            catch { process.stdout.write("unreadable"); }
          });
        ' "$version" 2>/dev/null || true)
    if [ "$seen" = "$version" ] && [ "$listed" = "yes" ]; then
      echo "  $name@$version is in the registry metadata (after ${waited}s)"
      return 0
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "::error::$name@$version not in the registry metadata after ${limit}s (npm view: ${seen:-nothing}, install packument: ${listed:-no answer}); not publishing packages that depend on it"
      return 1
    fi
    echo "  waiting for $name@$version (npm view: ${seen:-nothing}, install packument: ${listed:-no answer})"
    sleep "$interval"
    waited=$((waited + interval))
  done
}

# ---------------------------------------------------------------------------

WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chant-publish.XXXXXX")

declare -A LAYER NAME VERSION DEPS NEEDED LIVE STATE TGZ NOTE PROBE
ORDER=()
MAXLAYER=0

while IFS=$'\t' read -r layer dir name version deps; do
  [ -n "$dir" ] || continue
  if [ -z "$name" ] || [ -z "$version" ]; then
    echo "::warning::$dir/package.json has no name or version — skipping"
    continue
  fi
  ORDER+=("$dir")
  LAYER[$dir]=$layer
  NAME[$dir]=$name
  VERSION[$dir]=$version
  DEPS[$dir]=$deps
  NEEDED[$dir]=""
  NOTE[$dir]=""
  [ "$layer" -gt "$MAXLAYER" ] && MAXLAYER=$layer
done < <(publish_layers)

while read -r dir; do
  [ -n "$dir" ] && [ -n "${NAME[$dir]+x}" ] && NEEDED[$dir]=1
done < <(depended_on_dirs)

slug() { printf '%s' "${1//\//_}"; }

layer_dirs() {
  local d
  for d in "${ORDER[@]}"; do
    [ "${LAYER[$d]}" = "$1" ] && printf '%s\n' "$d"
  done
}

# Run a command in the background, at most $2 at a time, with its output in
# $WORK/<tag>.log and its exit status in $WORK/<tag>.rc.
bg() {
  local tag="$1" limit="$2"
  shift 2
  while [ "$(jobs -rp | wc -l)" -ge "$limit" ]; do wait -n; done
  ( "$@" > "$WORK/$tag.log" 2>&1; echo $? > "$WORK/$tag.rc" ) &
}

bg_rc() { cat "$WORK/$1.rc" 2>/dev/null || echo 1; }

show_log() {
  echo "::group::$1"
  cat "$WORK/$2.log" 2>/dev/null
  echo "::endgroup::"
}

# A failed or blocked workspace dependency, if the package has one.
failed_dep() {
  local dep
  for dep in ${DEPS[$1]//,/ }; do
    case "${STATE[$dep]:-}" in
      pack-failed|publish-failed|wait-failed|blocked) printf '%s' "${NAME[$dep]}"; return 0 ;;
    esac
  done
  return 1
}

# Whether a package still to be published in this run depends on $1.
needed_now() {
  local d
  for d in "${ORDER[@]}"; do
    [ "${STATE[$d]:-}" = "packed" ] || continue
    case ",${DEPS[$d]}," in *",$1,"*) return 0 ;; esac
  done
  return 1
}

# What is on npm already. An unpublished package returns nothing here, which
# correctly reads as "not at $version yet" and falls through to publish.
for dir in "${ORDER[@]}"; do
  bg "live-$(slug "$dir")" 8 npm view --prefer-online "${NAME[$dir]}" version
done
wait
for dir in "${ORDER[@]}"; do
  LIVE[$dir]=$(tr -d '[:space:]' < "$WORK/live-$(slug "$dir").log" 2>/dev/null)
  # A failed lookup (no such package yet) prints npm's error, not a version.
  [ "$(bg_rc "live-$(slug "$dir")")" = "0" ] || LIVE[$dir]=""
done

print_plan() {
  local l d action
  echo "publish plan (layer: package version, action):"
  for l in $(seq 0 "$MAXLAYER"); do
    echo "  layer $l"
    while read -r d; do
      [ -n "$d" ] || continue
      if [ "${LIVE[$d]}" = "${VERSION[$d]}" ]; then
        if [ -n "${NEEDED[$d]}" ]; then action="already published; prepack only, a dependent builds against it"
        else action="already published; skip"; fi
      else
        action="publish (live: ${LIVE[$d]:-none})"
        [ -n "${NEEDED[$d]}" ] && action="$action, then wait on its metadata if a dependent publishes"
      fi
      [ -n "${STATE[$d]:-}" ] && action="$action [${STATE[$d]}${TGZ[$d]:+ ${TGZ[$d]}}]"
      printf '    %s %s: %s\n' "${NAME[$d]}" "${VERSION[$d]}" "$action"
    done < <(layer_dirs "$l")
  done
}

if [ "$DRY_RUN" = "plan" ]; then
  print_plan
  exit 0
fi

# 1. Pack, layer by layer.
#
# Skipping the publish is not the same as skipping the build. A dependent in a
# later layer compiles against this package's *generated* output, and the only
# thing that produces it is a prepack. A package already at $version would
# leave nothing on disk, and the dependent fails on a module that was never
# built. That is not a corner case, it is every retry: chant-v0.34.0's rerun
# found k8s already at 0.34.0, skipped it, and helm failed on
# `@intentius/chant-lexicon-k8s/generated/index` exactly as it had the first
# time. So a package already published still runs its prepack when something
# depends on it.
pack_one() {
  local dir="$1" dest="$2"
  mkdir -p "$dest"
  (cd "$dir" && npm pack --pack-destination "$dest")
}

prepack_only() {
  (cd "$1" && npm run prepack)
}

pack_started=$SECONDS
for l in $(seq 0 "$MAXLAYER"); do
  mapfile -t dirs < <(layer_dirs "$l")
  for dir in "${dirs[@]}"; do
    s=$(slug "$dir")
    if [ "${LIVE[$dir]}" != "${VERSION[$dir]}" ] && dep=$(failed_dep "$dir"); then
      STATE[$dir]=blocked
      NOTE[$dir]="not built: $dep failed"
      echo "::error::${NAME[$dir]}@${VERSION[$dir]} not built or published: its dependency $dep failed"
    elif [ "${LIVE[$dir]}" = "${VERSION[$dir]}" ]; then
      if [ -n "${NEEDED[$dir]}" ]; then
        STATE[$dir]=building
        bg "pack-$s" "$PACK_JOBS" prepack_only "$dir"
      else
        STATE[$dir]=live
      fi
    else
      STATE[$dir]=packing
      bg "pack-$s" "$PACK_JOBS" pack_one "$dir" "$WORK/tgz/$s"
    fi
  done
  wait
  for dir in "${dirs[@]}"; do
    s=$(slug "$dir")
    case "${STATE[$dir]}" in
      building)
        STATE[$dir]=live
        if [ "$(bg_rc "pack-$s")" != "0" ]; then
          show_log "prepack ${NAME[$dir]} (already published) FAILED" "pack-$s"
          echo "::warning::${NAME[$dir]} is already published but its prepack failed; a dependent may not build"
        fi
        ;;
      packing)
        tgz=$(find "$WORK/tgz/$s" -maxdepth 1 -name '*.tgz' 2>/dev/null | head -1)
        if [ "$(bg_rc "pack-$s")" = "0" ] && [ -n "$tgz" ]; then
          STATE[$dir]=packed
          TGZ[$dir]=$tgz
          show_log "pack ${NAME[$dir]}@${VERSION[$dir]}" "pack-$s"
        else
          STATE[$dir]=pack-failed
          NOTE[$dir]="pack failed"
          show_log "pack ${NAME[$dir]}@${VERSION[$dir]} FAILED" "pack-$s"
          echo "::error::${NAME[$dir]}@${VERSION[$dir]}: npm pack failed; packages that depend on it will not publish"
        fi
        ;;
    esac
  done
done
pack_secs=$((SECONDS - pack_started))
echo "packed in ${pack_secs}s"

if [ -n "$DRY_RUN" ]; then
  print_plan
  echo "DRY_RUN=$DRY_RUN: tarballs are in $WORK/tgz; nothing was published"
  exit 0
fi

# 2. Publish, layer by layer. Each layer publishes in parallel, then waits for
# the metadata of whatever a later package in this run depends on (#3842).
publish_started=$SECONDS
for l in $(seq 0 "$MAXLAYER"); do
  mapfile -t dirs < <(layer_dirs "$l")
  for dir in "${dirs[@]}"; do
    [ "${STATE[$dir]}" = "packed" ] || continue
    if dep=$(failed_dep "$dir"); then
      STATE[$dir]=blocked
      NOTE[$dir]="not published: $dep failed"
      echo "::error::${NAME[$dir]}@${VERSION[$dir]} not published: its dependency $dep failed"
      continue
    fi
    STATE[$dir]=publishing
    bg "pub-$(slug "$dir")" 16 publish_one "$dir" "${NAME[$dir]}" "${TGZ[$dir]}"
  done
  wait
  for dir in "${dirs[@]}"; do
    [ "${STATE[$dir]}" = "publishing" ] || continue
    s=$(slug "$dir")
    show_log "publish ${NAME[$dir]}@${VERSION[$dir]}" "pub-$s"
    if [ "$(bg_rc "pub-$s")" = "0" ]; then
      STATE[$dir]=published
    else
      STATE[$dir]=publish-failed
      NOTE[$dir]="publish failed"
      echo "::error::${NAME[$dir]}@${VERSION[$dir]}: npm publish failed"
    fi
  done

  waiting=()
  for dir in "${dirs[@]}"; do
    if [ "${STATE[$dir]}" = "published" ] && needed_now "$dir"; then
      waiting+=("$dir")
      bg "wait-$(slug "$dir")" 16 wait_visible "${NAME[$dir]}" "${VERSION[$dir]}"
    fi
  done
  wait
  for dir in ${waiting[@]+"${waiting[@]}"}; do
    s=$(slug "$dir")
    show_log "metadata ${NAME[$dir]}@${VERSION[$dir]}" "wait-$s"
    if [ "$(bg_rc "wait-$s")" != "0" ]; then
      # On npm, so it stays in the published list for `untag`, but nothing
      # that needs it publishes, and the run fails.
      STATE[$dir]=wait-failed
      NOTE[$dir]="published, but not in the registry metadata after ${WAIT_TIMEOUT:-1800}s"
    else
      NOTE[$dir]="metadata visible: $(tail -1 "$WORK/wait-$s.log" | sed -n 's/.*(after \(.*\))$/\1/p')"
    fi
  done
done
publish_secs=$((SECONDS - publish_started))

# 3. One tarball probe per published package, now that every version is in
# the metadata. Reported, never fatal: a CDN that is slow to serve a file the
# registry has accepted is not a failed release.
for dir in "${ORDER[@]}"; do
  case "${STATE[$dir]}" in published|wait-failed) ;; *) continue ;; esac
  name=${NAME[$dir]}
  PROBE[$dir]=$(curl -s -o /dev/null -w '%{http_code}' \
    "$REGISTRY/${name}/-/${name##*/}-${VERSION[$dir]}.tgz" 2>/dev/null || echo none)
  if [ "${PROBE[$dir]}" != "200" ]; then
    echo "::warning::$name@${VERSION[$dir]}: tarball answered HTTP ${PROBE[$dir]} (not failing; the CDN may still be catching up)"
  fi
done

published=()
skipped=()
failed=()
for dir in "${ORDER[@]}"; do
  entry="${NAME[$dir]}@${VERSION[$dir]}"
  case "${STATE[$dir]}" in
    published) published+=("$entry") ;;
    wait-failed) published+=("$entry"); failed+=("$entry") ;;
    live) skipped+=("$entry") ;;
    *) failed+=("$entry") ;;
  esac
done

summary() {
  echo "### npm publish"
  echo
  echo "pack ${pack_secs}s, publish and metadata waits ${publish_secs}s"
  echo
  printf '| package | version | result | notes | tarball |\n|---|---|---|---|---|\n'
  local dir result
  for dir in "${ORDER[@]}"; do
    case "${STATE[$dir]}" in
      published) result="published" ;;
      live) result="already published" ;;
      *) result="**FAILED**" ;;
    esac
    # shellcheck disable=SC2016 # the backticks are Markdown, not a command
    printf '| `%s` | %s | %s | %s | %s |\n' "${NAME[$dir]}" "${VERSION[$dir]}" "$result" \
      "${NOTE[$dir]}" "${PROBE[$dir]:+HTTP ${PROBE[$dir]}}"
  done
}

summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "$GITHUB_STEP_SUMMARY"

echo
echo "published: ${#published[@]}  already published: ${#skipped[@]}  failed: ${#failed[@]}"

# What this run put on npm, for publish.yml's `untag` job (#3191): a release
# with any package on npm keeps its tag.
[ -n "${GITHUB_OUTPUT:-}" ] && echo "published=${published[*]:-}" >> "$GITHUB_OUTPUT"

if [ ${#failed[@]} -gt 0 ]; then
  echo "::error::${#failed[@]} package(s) failed to publish: ${failed[*]}"
  exit 1
fi
