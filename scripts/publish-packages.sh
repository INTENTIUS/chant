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
# if anything failed. Re-running resumes: a version already on npm is not
# published again, and a `latest` tag already at the version is not moved.
#
# Pack first (#3857). On chant-v0.124.7 (publish run 38189259355) this step
# took 2060s: about 7 minutes of prepack builds run one at a time inside each
# `npm publish`, and about 27 minutes in serial waits between dependency
# layers. Packing every package up front, layer by layer, took the builds out
# of the publish.
#
# Two ways to publish, chosen by CHANT_STAGED_PUBLISH.
#
# Unset (the default): publish the tarballs to `latest` layer by layer, a
# layer's packages in parallel. Before the next layer starts, wait until the
# registry metadata lists every version it depends on (`wait_visible`), never
# requesting a tarball URL. At the end, probe each published tarball once and
# report the status without failing the job. This is the #3857 flow.
#
# CHANT_STAGED_PUBLISH=1: stage under `next`, then move `latest` (#3903). It
# is opt-in because moving a dist-tag over OIDC needs "Allow npm dist-tag" on
# every package's trusted-publisher record, a manual setting on npmjs.com
# (#3904). publish.yml passes the repository variable of the same name, so it
# is switched on there once the records allow it.
#
# Publishing layer by layer
# still left each release partly visible for 10 to 30 minutes: a range
# consumer installing in that window got a mix of new and old packages, and
# tarballs whose metadata was listed still answered 404. The #3856 research
# reproduced this against a local registry with npm, pnpm, bun and yarn. All
# four prefer the `latest`-tagged version whenever it satisfies the range, so
# a version published under another tag is invisible to `^x` consumers until
# its `latest` moves. The staged run goes:
#
#   1. Pack. `npm pack` runs each prepack (generate, bundle, validate, build)
#      and leaves a tarball. Layer by layer, since a prepack compiles against
#      its dependencies' generated output; the packages in a layer pack in
#      parallel, PACK_JOBS at a time (default 4).
#   2. Publish every tarball with `--tag next`, in one parallel batch. Nothing
#      resolves a staged version, so nothing has to wait between packages.
#   3. Wait until each staged version is in the registry metadata and its
#      tarball answers 200 (`wait_staged`). The tarball is requested only
#      after the metadata lists the version: a request made before the CDN has
#      the file 404s, and that 404 stays cached for about 5 minutes (#3857).
#   4. Move `latest`, in tag waves (`tag_layers`): core and k8s-client first,
#      then the lexicons in parallel, then any lexicon that peers on another
#      lexicon. Each wave waits until the packument's dist-tags show it
#      (`wait_latest`) before the next starts. In the research, moving a
#      lexicon's `latest` before core's left pnpm, bun and yarn installing the
#      new lexicon against the old core, an unmet peer, with exit 0.
#
# If anything fails before step 4, no `latest` tag moves, the run lists what
# is staged, and it exits 1. A re-run skips the publish for every version
# already on npm (under `next` or otherwise) and only moves the tags.
#
# Moving a dist-tag over OIDC needs "Allow npm dist-tag" on the package's
# trusted-publisher record. It is off by default and separate from
# publishing (#3904), and npm only does the OIDC exchange for `dist-tag` from
# CLI 12.2.0, so the tag moves run that npm through npx when the installed
# one is older (DIST_TAG_NPM). A refused move says so by name, and falls back
# to NPM_TOKEN the way a refused publish does.
#
# Publishing a tarball keeps provenance: npm signs the attestation over the
# tarball's digest and takes the build identity from the OIDC environment,
# whichever way the tarball was produced. It runs no lifecycle scripts, which
# is the point here, since pack already ran prepack.
#
# Knobs:
#   CHANT_STAGED_PUBLISH=1  stage under `next`, then move `latest` (see above)
#   DRY_RUN=plan   print the plan and exit, building nothing
#   DRY_RUN=1      pack everything (real prepacks), print the plan, publish nothing
#   PACK_JOBS      parallel prepacks per layer (default 4)
#   PUBLISH_JOBS   staged: parallel publishes and tag moves (default 24)
#   WAIT_TIMEOUT   seconds to wait for a version's metadata, a staged version,
#                  or a moved tag, to show (default 1800)
#   WAIT_INTERVAL  seconds between polls (default 10)
#   DIST_TAG_NPM   staged: the npm command that moves tags (default: `npm` when it is
#                  12.2.0 or later, otherwise `npx --yes npm@12.2.0`)
set -uo pipefail

REGISTRY="https://registry.npmjs.org"
DRY_RUN="${DRY_RUN:-}"
PACK_JOBS="${PACK_JOBS:-4}"
PUBLISH_JOBS="${PUBLISH_JOBS:-24}"
STAGED=""
[ "${CHANT_STAGED_PUBLISH:-}" = "1" ] && STAGED=1
# The publish's tag arguments: none by default, so npm sets `latest`.
TAG_ARGS=()
[ -n "$STAGED" ] && TAG_ARGS=(--tag next)
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

# The order `latest` moves in, as tab-separated `wave dir` lines (#3903).
#
# A peer is the edge that matters. A consumer who asks for core and a lexicon
# by range installs whichever version each `latest` names, and if the
# lexicon's tag shows before core's, pnpm, bun and yarn install the new
# lexicon against the old core and exit 0 with the peer unmet (#3856). So a
# package's tag moves in a later wave than every package it peers on. Optional
# dependencies count as well, which puts k8s-client in the first wave with
# core (#1074).
#
# Plain dependencies do not. A dependency range that the `latest` version
# does not satisfy resolves to the highest version that does, staged or not,
# so a dependency can follow its dependent without breaking an install.
# Counting them would add a wave, and its propagation wait, for every layer
# of the in-family `dependencies` (otel, prometheus, k8s).
tag_layers() {
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

    const needs = new Map();
    for (const [d, p] of pkg) {
      const deps = Object.keys({ ...p.peerDependencies, ...p.optionalDependencies });
      needs.set(d, [...new Set(deps.map((n) => owner.get(n)).filter((x) => x && x !== d))]);
    }

    const wave = new Map();
    const left = new Set(pkg.keys());
    let n = 0;
    while (left.size) {
      let ready = [...left].filter((d) => !needs.get(d).some((x) => left.has(x))).sort();
      if (!ready.length) {
        console.error("tag order: peer cycle among " + [...left].sort().join(", "));
        ready = [...left].sort();
      }
      for (const d of ready) { wave.set(d, n); left.delete(d); }
      n++;
    }

    const out = [...wave.keys()].sort((a, b) => wave.get(a) - wave.get(b) || (a < b ? -1 : 1));
    for (const d of out) console.log(wave.get(d) + "\t" + d);
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

# Publish one packed tarball, under `next` when staged. Runs from the package's directory
# so npm reads the same config it would for a directory publish. Tries OIDC
# trusted publishing first (no .npmrc exists, so npm detects the absent auth
# plus the id-token environment and exchanges for a short-lived publish
# token). Falls back to NPM_TOKEN only when the registry says we are
# unauthenticated — a version conflict must not silently retry with a
# different credential.
#
# Staged only: a conflict means the version is on npm already, which a re-run can meet
# when the registry's read side lagged behind the check at the start. That is
# what a re-run is for, so it counts as already published, and says so.
publish_one() {
  local dir="$1" name="$2" tgz="$3" out rc npmrc

  out=$(cd "$dir" && npm publish "$tgz" --access public --provenance ${TAG_ARGS[@]+"${TAG_ARGS[@]}"} 2>&1)
  rc=$?
  printf '%s\n' "$out"
  [ $rc -eq 0 ] && return 0

  if [ -n "$STAGED" ] && npm_errors "$out" | grep -qiE 'cannot publish over|EPUBLISHCONFLICT'; then
    echo "ALREADY-ON-NPM: $name is already on npm at this version; nothing to publish"
    return 0
  fi

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
  out=$(cd "$dir" && NPM_CONFIG_USERCONFIG="$npmrc" npm publish "$tgz" --access public --provenance ${TAG_ARGS[@]+"${TAG_ARGS[@]}"} 2>&1)
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
    out=$(cd "$dir" && NPM_CONFIG_USERCONFIG="$npmrc" npm publish "$tgz" --access public ${TAG_ARGS[@]+"${TAG_ARGS[@]}"} 2>&1)
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

# Point `latest` at a staged version (#3903).
#
# Over OIDC this needs npm 12.2.0 or later (DIST_TAG_NPM) and "Allow npm
# dist-tag" on the package's trusted-publisher record (#3904). Without that
# option the exchange gives no token that may move tags, and npm answers 401
# or 403. That is a setting on npmjs.com, not something a re-run fixes, so it
# is named outright. Then it tries NPM_TOKEN, with the id-token environment
# removed: npm 12.2 exchanges over OIDC whenever it can, and the exchanged
# token would replace the configured one.
#
# Adding a tag that already points at the version is a warning and exit 0 in
# npm, so a re-run that gets here for a moved tag does no harm.
move_latest() {
  local name="$1" version="$2" out rc npmrc
  # shellcheck disable=SC2086 # DIST_TAG_NPM may be a command with arguments
  out=$(cd "$WORK" && $DIST_TAG_NPM dist-tag add "$name@$version" latest 2>&1)
  rc=$?
  printf '%s\n' "$out"
  [ $rc -eq 0 ] && return 0

  if ! printf '%s' "$out" | grep -qE 'E401|E403|ENEEDAUTH|need auth|403 Forbidden'; then
    return $rc
  fi

  local refused="$name: npm refused to move latest to $version (no permission to change dist-tags). Moving a dist-tag over OIDC needs \"Allow npm dist-tag\" on the trusted-publisher record, which is off by default and separate from publishing. Turn it on for $name at https://www.npmjs.com/package/$name/access (INTENTIUS/chant#3904)"
  echo "  $refused"
  oidc_reason "$name"

  if [ -z "${NPM_TOKEN:-}" ]; then
    echo "::error::$refused, then re-run this job. NPM_TOKEN is not set, so there is no fallback."
    return $rc
  fi

  echo "  $name: retrying the tag move with NPM_TOKEN"
  npmrc=$(mktemp)
  chmod 600 "$npmrc"
  printf '%s/:_authToken=%s\n' "${REGISTRY#https:}" "$NPM_TOKEN" > "$npmrc"
  # shellcheck disable=SC2086
  out=$(cd "$WORK" && env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    NPM_CONFIG_USERCONFIG="$npmrc" $DIST_TAG_NPM dist-tag add "$name@$version" latest 2>&1)
  rc=$?
  printf '%s\n' "$out"
  rm -f "$npmrc"

  if [ $rc -eq 0 ]; then
    echo "MOVED-WITH-TOKEN"
    echo "::warning::$refused, so the next release moves it over OIDC. This one moved with NPM_TOKEN."
  elif npm_errors "$out" | grep -q 'EOTP'; then
    echo "::error::$refused, then re-run this job. NPM_TOKEN requires a one-time password, so it cannot move a tag from CI."
  else
    echo "::error::$refused, then re-run this job. The NPM_TOKEN fallback failed too."
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

# One reading of the abbreviated packument, the document `npm install` reads:
#   packument <name> has <version>   prints yes, no or unreadable
#   packument <name> latest          prints the latest dist-tag, or nothing
packument() {
  curl -sfL -H 'Accept: application/vnd.npm.install-v1+json' "$REGISTRY/${1//\//%2f}" 2>/dev/null \
    | node -e '
        let s = "";
        process.stdin.on("data", (c) => (s += c)).on("end", () => {
          let p;
          try { p = JSON.parse(s); } catch { process.stdout.write("unreadable"); return; }
          if (process.argv[1] === "has") process.stdout.write(p.versions?.[process.argv[2]] ? "yes" : "no");
          else process.stdout.write(p["dist-tags"]?.latest ?? "");
        });
      ' "$2" "${3:-}" 2>/dev/null || true
}

# Wait until a staged version can be installed by name: the registry metadata
# lists it and its tarball answers 200.
#
# #3842: npm is eventually consistent across packages, and ETARGET means the
# packument did not list the version, so the metadata is read both ways a
# client reads it: `npm view` (the full packument) and the abbreviated
# packument `npm install` fetches. `--prefer-online` matters: the check at the
# start of the run already read this packument, and npm's local cache would
# otherwise serve that copy for its max-age (300s).
#
# The tarball is not requested until a poll after the one that found the
# metadata. A request made before the CDN has the file 404s, and that 404
# appears to stay cached for about 5 minutes (#3857). Nothing installs a
# staged version, so a slow tarball here only makes the job slower.
#
# Writes the last tarball status to $3. Polls every WAIT_INTERVAL seconds
# (default 10) up to WAIT_TIMEOUT seconds (default 1800).
wait_staged() {
  local name="$1" version="$2" probe_file="$3" waited=0 seen listed code="" listed_at=""
  local interval="${WAIT_INTERVAL:-10}" limit="${WAIT_TIMEOUT:-1800}"
  local tarball="$REGISTRY/${name}/-/${name##*/}-${version}.tgz"
  while :; do
    if [ -n "$listed_at" ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' "$tarball" 2>/dev/null || echo none)
      printf '%s\n' "$code" > "$probe_file"
      if [ "$code" = "200" ]; then
        echo "  $name@$version is staged: metadata after ${listed_at}s, tarball 200 after ${waited}s"
        return 0
      fi
    else
      seen=$(npm view --prefer-online "$name@$version" version 2>/dev/null || true)
      listed=$(packument "$name" has "$version")
      if [ "$seen" = "$version" ] && [ "$listed" = "yes" ]; then
        listed_at=$waited
        echo "  $name@$version is in the registry metadata (after ${waited}s)"
      fi
    fi
    if [ "$waited" -ge "$limit" ]; then
      if [ -z "$listed_at" ]; then
        echo "::error::$name@$version not in the registry metadata after ${limit}s (npm view: ${seen:-nothing}, install packument: ${listed:-no answer})"
      else
        echo "::error::$name@$version is in the metadata, but its tarball answered HTTP ${code:-nothing} after ${limit}s"
      fi
      return 1
    fi
    if [ -z "$listed_at" ]; then
      echo "  waiting for $name@$version (npm view: ${seen:-nothing}, install packument: ${listed:-no answer})"
    elif [ -n "$code" ]; then
      echo "  waiting for the $name@$version tarball (HTTP $code)"
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
}

# Wait until both readings of the packument say `latest` is the version: the
# next tag wave must not start before a client would see this one.
wait_latest() {
  local name="$1" version="$2" waited=0 seen listed
  local interval="${WAIT_INTERVAL:-10}" limit="${WAIT_TIMEOUT:-1800}"
  while :; do
    seen=$(npm view --prefer-online "$name" dist-tags.latest 2>/dev/null | tr -d '[:space:]' || true)
    listed=$(packument "$name" latest)
    if [ "$seen" = "$version" ] && [ "$listed" = "$version" ]; then
      echo "  $name: latest is $version (shown after ${waited}s)"
      return 0
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "::error::$name: latest not shown as $version after ${limit}s (npm view: ${seen:-nothing}, install packument: ${listed:-no answer})"
      return 1
    fi
    echo "  waiting for $name latest -> $version (npm view: ${seen:-nothing}, install packument: ${listed:-no answer})"
    sleep "$interval"
    waited=$((waited + interval))
  done
}

# ---------------------------------------------------------------------------

WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chant-publish.XXXXXX")

declare -A LAYER NAME VERSION DEPS NEEDED LISTED LATEST STATE TGZ NOTE PROBE WAVE TAG TAGNOTE
ORDER=()
MAXLAYER=0
MAXWAVE=0

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
  TAG[$dir]=""
  TAGNOTE[$dir]=""
  WAVE[$dir]=0
  [ "$layer" -gt "$MAXLAYER" ] && MAXLAYER=$layer
done < <(publish_layers)

while read -r dir; do
  [ -n "$dir" ] && [ -n "${NAME[$dir]+x}" ] && NEEDED[$dir]=1
done < <(depended_on_dirs)

while IFS=$'\t' read -r wave dir; do
  [ -n "$dir" ] && [ -n "${NAME[$dir]+x}" ] || continue
  WAVE[$dir]=$wave
  [ "$wave" -gt "$MAXWAVE" ] && MAXWAVE=$wave
done < <(tag_layers)

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

# Whether version $1 sorts after version $2.
newer() {
  [ -n "$1" ] && [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# Whether this run has to point `latest` at the package's version: not when it
# is there already, and never backwards past a newer release.
tag_to_move() {
  [ "${LATEST[$1]}" != "${VERSION[$1]}" ] && ! newer "${LATEST[$1]}" "${VERSION[$1]}"
}

# What is on npm already: whether the version is listed (under any tag), and
# where `latest` points. A version staged under `next` by an earlier run that
# failed is listed with `latest` elsewhere, and only its tag is left to move.
#
# Without staging, only `latest` counts, as before: an unpublished package
# returns nothing, which reads as "not at $version yet" and publishes.
for dir in "${ORDER[@]}"; do
  s=$(slug "$dir")
  if [ -n "$STAGED" ]; then
    bg "listed-$s" 8 npm view --prefer-online "${NAME[$dir]}@${VERSION[$dir]}" version
    bg "latest-$s" 8 npm view --prefer-online "${NAME[$dir]}" dist-tags.latest
  else
    bg "latest-$s" 8 npm view --prefer-online "${NAME[$dir]}" version
  fi
done
wait
for dir in "${ORDER[@]}"; do
  s=$(slug "$dir")
  LISTED[$dir]=""
  if [ "$(bg_rc "listed-$s")" = "0" ] \
    && [ "$(tr -d '[:space:]' < "$WORK/listed-$s.log" 2>/dev/null)" = "${VERSION[$dir]}" ]; then
    LISTED[$dir]=1
  fi
  # A failed lookup (no such package yet) prints npm's error, not a version.
  LATEST[$dir]=""
  [ "$(bg_rc "latest-$s")" = "0" ] && LATEST[$dir]=$(tr -d '[:space:]' < "$WORK/latest-$s.log" 2>/dev/null)
  [ -z "$STAGED" ] && [ "${LATEST[$dir]}" = "${VERSION[$dir]}" ] && LISTED[$dir]=1
done

print_plan_layered() {
  local l d action
  echo "publish plan (layer: package version, action):"
  for l in $(seq 0 "$MAXLAYER"); do
    echo "  layer $l"
    while read -r d; do
      [ -n "$d" ] || continue
      if [ "${LATEST[$d]}" = "${VERSION[$d]}" ]; then
        if [ -n "${NEEDED[$d]}" ]; then action="already published; prepack only, a dependent builds against it"
        else action="already published; skip"; fi
      else
        action="publish (live: ${LATEST[$d]:-none})"
        [ -n "${NEEDED[$d]}" ] && action="$action, then wait on its metadata if a dependent publishes"
      fi
      [ -n "${STATE[$d]:-}" ] && action="$action [${STATE[$d]}${TGZ[$d]:+ ${TGZ[$d]}}]"
      printf '    %s %s: %s\n' "${NAME[$d]}" "${VERSION[$d]}" "$action"
    done < <(layer_dirs "$l")
  done
}

print_plan() {
  [ -n "$STAGED" ] || { print_plan_layered; return; }
  local l w d action names
  echo "publish plan (layer: package version, action):"
  for l in $(seq 0 "$MAXLAYER"); do
    echo "  layer $l"
    while read -r d; do
      [ -n "$d" ] || continue
      if [ -z "${LISTED[$d]}" ]; then
        action="publish under next (latest: ${LATEST[$d]:-none})"
      elif [ "${LATEST[$d]}" = "${VERSION[$d]}" ]; then
        action="already published and latest; skip"
      elif newer "${LATEST[$d]}" "${VERSION[$d]}"; then
        action="already published; latest is ${LATEST[$d]}, newer, left alone"
      else
        action="already on npm, latest is ${LATEST[$d]:-none}; move latest only"
      fi
      if [ -n "${LISTED[$d]}" ] && [ -n "${NEEDED[$d]}" ]; then
        action="$action; prepack only, a dependent builds against it"
      fi
      [ -n "${STATE[$d]:-}" ] && action="$action [${STATE[$d]}${TGZ[$d]:+ ${TGZ[$d]}}]"
      printf '    %s %s: %s\n' "${NAME[$d]}" "${VERSION[$d]}" "$action"
    done < <(layer_dirs "$l")
  done
  echo "latest moves, once every staged version installs (wave: packages):"
  for w in $(seq 0 "$MAXWAVE"); do
    names=""
    for d in "${ORDER[@]}"; do
      [ "${WAVE[$d]}" = "$w" ] && tag_to_move "$d" && names="$names ${NAME[$d]}"
    done
    echo "  wave $w:${names:- nothing to move}"
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
# thing that produces it is a prepack. A package already published would
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
    if [ -z "${LISTED[$dir]}" ] && dep=$(failed_dep "$dir"); then
      STATE[$dir]=blocked
      NOTE[$dir]="not built: $dep failed"
      echo "::error::${NAME[$dir]}@${VERSION[$dir]} not built or published: its dependency $dep failed"
    elif [ -n "${LISTED[$dir]}" ]; then
      if [ -n "${NEEDED[$dir]}" ]; then
        STATE[$dir]=building
        bg "pack-$s" "$PACK_JOBS" prepack_only "$dir"
      else
        STATE[$dir]=on-npm
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
        STATE[$dir]=on-npm
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

if [ -z "$STAGED" ]; then
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
      on-npm) skipped+=("$entry") ;;
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
        on-npm) result="already published" ;;
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
  exit 0
fi

# 2. Publish every tarball under `next`, all at once. A staged version is
# invisible to range consumers, so no package has to wait for another here.
publish_started=$SECONDS
for dir in "${ORDER[@]}"; do
  [ "${STATE[$dir]}" = "packed" ] || continue
  STATE[$dir]=publishing
  bg "pub-$(slug "$dir")" "$PUBLISH_JOBS" publish_one "$dir" "${NAME[$dir]}" "${TGZ[$dir]}"
done
wait
for dir in "${ORDER[@]}"; do
  [ "${STATE[$dir]}" = "publishing" ] || continue
  s=$(slug "$dir")
  show_log "publish ${NAME[$dir]}@${VERSION[$dir]} --tag next" "pub-$s"
  if [ "$(bg_rc "pub-$s")" != "0" ]; then
    STATE[$dir]=publish-failed
    NOTE[$dir]="publish failed"
    echo "::error::${NAME[$dir]}@${VERSION[$dir]}: npm publish failed"
  elif grep -q '^ALREADY-ON-NPM' "$WORK/pub-$s.log"; then
    STATE[$dir]=on-npm
    NOTE[$dir]="found on npm at publish"
  else
    STATE[$dir]=published
  fi
done
publish_secs=$((SECONDS - publish_started))

# 3. Wait until every version whose `latest` moves can be installed by name.
wait_started=$SECONDS
staging=()
for dir in "${ORDER[@]}"; do
  case "${STATE[$dir]}" in published|on-npm) ;; *) continue ;; esac
  tag_to_move "$dir" || continue
  staging+=("$dir")
  bg "stage-$(slug "$dir")" 32 wait_staged "${NAME[$dir]}" "${VERSION[$dir]}" "$WORK/probe-$(slug "$dir")"
done
wait
for dir in ${staging[@]+"${staging[@]}"}; do
  s=$(slug "$dir")
  show_log "staged ${NAME[$dir]}@${VERSION[$dir]}" "stage-$s"
  PROBE[$dir]=$(cat "$WORK/probe-$s" 2>/dev/null)
  if [ "$(bg_rc "stage-$s")" = "0" ]; then
    NOTE[$dir]="${NOTE[$dir]:+${NOTE[$dir]}; }$(tail -1 "$WORK/stage-$s.log" | sed -n 's/.* is staged: \(.*\)$/\1/p')"
  else
    STATE[$dir]=wait-failed
    NOTE[$dir]="on npm under next, but not installable after ${WAIT_TIMEOUT:-1800}s"
  fi
done
wait_secs=$((SECONDS - wait_started))

# 4. Move `latest`, wave by wave, only when nothing failed before this point.
held=()
for dir in "${ORDER[@]}"; do
  case "${STATE[$dir]}" in
    pack-failed|blocked|publish-failed|wait-failed) held+=("${NAME[$dir]}@${VERSION[$dir]}") ;;
  esac
done

hold_tags() {
  local d
  for d in "${ORDER[@]}"; do
    case "${STATE[$d]}" in published|on-npm|wait-failed) ;; *) continue ;; esac
    tag_to_move "$d" || continue
    TAG[$d]=held
    TAGNOTE[$d]="$1"
  done
}

tags_started=$SECONDS
first_move=""
last_shown=""
to_move=0
for dir in "${ORDER[@]}"; do
  case "${STATE[$dir]}" in published|on-npm) tag_to_move "$dir" && to_move=$((to_move + 1)) ;; esac
done
if [ ${#held[@]} -gt 0 ]; then
  hold_tags "not moved: the release did not fully stage"
elif [ "$to_move" -gt 0 ]; then
  if [ -z "${DIST_TAG_NPM:-}" ]; then
    if [ "$(printf '%s\n%s\n' 12.2.0 "$(npm --version 2>/dev/null)" | sort -V | head -1)" = "12.2.0" ]; then
      DIST_TAG_NPM=npm
    else
      DIST_TAG_NPM="npx --yes npm@12.2.0"
    fi
  fi
  # Fetch it once, here, rather than in every parallel tag move.
  # shellcheck disable=SC2086
  if ! dtv=$(cd "$WORK" && $DIST_TAG_NPM --version 2>&1); then
    echo "::error::cannot run '$DIST_TAG_NPM' to move dist-tags: $dtv"
    hold_tags "not moved: no npm that can move dist-tags"
  else
    echo "moving latest with '$DIST_TAG_NPM' (npm $dtv)"
    stop=""
    for w in $(seq 0 "$MAXWAVE"); do
      movers=()
      for dir in "${ORDER[@]}"; do
        [ "${WAVE[$dir]}" = "$w" ] || continue
        case "${STATE[$dir]}" in published|on-npm) ;; *) continue ;; esac
        if [ "${LATEST[$dir]}" = "${VERSION[$dir]}" ]; then TAG[$dir]=already; continue; fi
        if newer "${LATEST[$dir]}" "${VERSION[$dir]}"; then TAG[$dir]=ahead; continue; fi
        if [ -n "$stop" ]; then
          TAG[$dir]=held
          TAGNOTE[$dir]="not moved: $stop"
          continue
        fi
        movers+=("$dir")
      done
      [ ${#movers[@]} -gt 0 ] || continue
      [ -n "$first_move" ] || first_move=$SECONDS
      echo "latest, wave $w: ${#movers[@]} package(s)"
      for dir in "${movers[@]}"; do
        bg "tag-$(slug "$dir")" "$PUBLISH_JOBS" move_latest "${NAME[$dir]}" "${VERSION[$dir]}"
      done
      wait
      shown=()
      for dir in "${movers[@]}"; do
        s=$(slug "$dir")
        show_log "latest ${NAME[$dir]}@${VERSION[$dir]}" "tag-$s"
        if [ "$(bg_rc "tag-$s")" = "0" ]; then
          shown+=("$dir")
          grep -q '^MOVED-WITH-TOKEN' "$WORK/tag-$s.log" && TAGNOTE[$dir]="moved with NPM_TOKEN; "
          bg "shown-$s" 32 wait_latest "${NAME[$dir]}" "${VERSION[$dir]}"
        else
          TAG[$dir]=move-failed
          if grep -q 'Allow npm dist-tag' "$WORK/tag-$s.log"; then
            TAGNOTE[$dir]="refused: turn on \"Allow npm dist-tag\" for this package on npmjs.com"
          else
            TAGNOTE[$dir]="npm dist-tag add failed"
          fi
          stop="${NAME[$dir]} did not move"
        fi
      done
      wait
      for dir in ${shown[@]+"${shown[@]}"}; do
        s=$(slug "$dir")
        show_log "latest shown ${NAME[$dir]}@${VERSION[$dir]}" "shown-$s"
        if [ "$(bg_rc "shown-$s")" = "0" ]; then
          TAG[$dir]=moved
          TAGNOTE[$dir]="${TAGNOTE[$dir]}$(tail -1 "$WORK/shown-$s.log" | sed -n 's/.*(\(shown after .*\))$/\1/p')"
          last_shown=$SECONDS
        else
          TAG[$dir]=not-shown
          TAGNOTE[$dir]="${TAGNOTE[$dir]}moved, not shown after ${WAIT_TIMEOUT:-1800}s"
          stop="${NAME[$dir]}'s latest did not show"
        fi
      done
    done
  fi
fi
tags_secs=$((SECONDS - tags_started))

published=()
failed=()
tag_failed=()
staged=()
for dir in "${ORDER[@]}"; do
  entry="${NAME[$dir]}@${VERSION[$dir]}"
  case "${STATE[$dir]}" in
    published) published+=("$entry") ;;
    wait-failed) published+=("$entry"); failed+=("$entry") ;;
    on-npm) ;;
    *) failed+=("$entry") ;;
  esac
  case "${TAG[$dir]}" in
    move-failed|not-shown) tag_failed+=("$entry") ;;
    held) staged+=("$entry") ;;
  esac
done

latest_cell() {
  case "${TAG[$1]}" in
    moved) printf 'moved (%s)' "${TAGNOTE[$1]}" ;;
    already) printf 'already' ;;
    ahead) printf 'left at %s (newer)' "${LATEST[$1]}" ;;
    held) printf '**not moved** (at %s)' "${LATEST[$1]:-none}" ;;
    move-failed) printf '**move FAILED**: %s' "${TAGNOTE[$1]}" ;;
    not-shown) printf '**%s**' "${TAGNOTE[$1]}" ;;
    *)
      if [ "${LATEST[$1]}" = "${VERSION[$1]}" ]; then printf 'already'
      else printf '%s' "${LATEST[$1]:+at ${LATEST[$1]}}"; fi ;;
  esac
}

summary() {
  echo "### npm publish"
  echo
  echo "pack ${pack_secs}s, publish under next ${publish_secs}s, staging waits ${wait_secs}s, latest moves ${tags_secs}s"
  if [ -n "$first_move" ] && [ -n "$last_shown" ]; then
    echo
    echo "consumer-visible window (first latest move to the last one shown): $((last_shown - first_move))s"
  fi
  echo
  printf '| package | version | result | notes | tarball | latest |\n|---|---|---|---|---|---|\n'
  local dir result
  for dir in "${ORDER[@]}"; do
    case "${STATE[$dir]}" in
      published) result="published under next" ;;
      on-npm) result="already on npm" ;;
      *) result="**FAILED**" ;;
    esac
    # shellcheck disable=SC2016 # the backticks are Markdown, not a command
    printf '| `%s` | %s | %s | %s | %s | %s |\n' "${NAME[$dir]}" "${VERSION[$dir]}" "$result" \
      "${NOTE[$dir]}" "${PROBE[$dir]:+HTTP ${PROBE[$dir]}}" "$(latest_cell "$dir")"
  done
}

summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "$GITHUB_STEP_SUMMARY"

echo
echo "published: ${#published[@]}  failed: ${#failed[@]}  latest not moved: ${#staged[@]}  latest move failed: ${#tag_failed[@]}"

# What this run put on npm, for publish.yml's `untag` job (#3191): a release
# with any package on npm keeps its tag. A version staged under `next` is on
# npm, so it keeps the tag too, and a re-run resumes from it.
[ -n "${GITHUB_OUTPUT:-}" ] && echo "published=${published[*]:-}" >> "$GITHUB_OUTPUT"

rc=0
if [ ${#failed[@]} -gt 0 ]; then
  echo "::error::${#failed[@]} package(s) failed before the tag move: ${failed[*]}"
  rc=1
fi
if [ ${#staged[@]} -gt 0 ]; then
  echo "::error::latest was left where it was for ${#staged[@]} package(s), which are on npm under next only: ${staged[*]}. Fix the cause and re-run the job: versions already on npm are not published again, and only the tags move."
  rc=1
fi
if [ ${#tag_failed[@]} -gt 0 ]; then
  echo "::error::latest did not move for: ${tag_failed[*]}"
  rc=1
fi
exit $rc
