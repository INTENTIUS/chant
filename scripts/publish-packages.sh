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
# Never stops on the first failure — every package gets its attempt, and the
# run exits non-zero at the end if any of them failed. The skip-if-unchanged
# check makes re-running idempotent, so a partial release is recovered by
# re-running the workflow.
set -uo pipefail

REGISTRY="https://registry.npmjs.org"

# Every workspace directory that npm would actually publish, in an order where
# a package always follows the workspace packages it depends on. `private: true`
# packages (packages/test-utils) are skipped the same way npm would skip them.
#
# The order is derived, not listed. Each `npm publish` re-runs that package's
# prepack, and a prepack both builds against and imports its workspace
# dependencies' *generated* output — so publishing a dependent first fails on a
# module that does not exist yet. Directory order used to stand in for this, and
# it happened to be right until it was not: chant-v0.34.0 stranded
# lexicon-forgejo (needs github's `src/generated/index`) and lexicon-helm (needs
# k8s's `dist/generated/index.d.ts`), because `forgejo` < `github` and
# `helm` < `k8s`. Any future lexicon that depends on an alphabetically later one
# would have done the same.
#
# Edges come from dependencies, peerDependencies and optionalDependencies.
# Optional counts: the k8s lexicon declares @intentius/chant-k8s-client optional
# (#1074), and npm tolerates an optional dependency that fails to resolve, so
# publishing the client after the lexicon degrades `chant lifecycle diff --live`
# to holes on a registry install rather than failing loudly.
publishable_dirs() {
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
      needs.set(d, new Set(deps.map((n) => owner.get(n)).filter((x) => x && x !== d)));
    }

    // Kahn, alphabetical among whatever is ready, so the order is stable and
    // reviewable rather than dependent on Map insertion.
    const out = [];
    const left = new Set(pkg.keys());
    while (left.size) {
      const ready = [...left].filter((d) => ![...needs.get(d)].some((n) => left.has(n))).sort();
      if (!ready.length) {
        // A cycle. Emit the rest in directory order rather than publishing
        // nothing — npm will say which package could not build.
        console.error("publish order: dependency cycle among " + [...left].sort().join(", "));
        out.push(...[...left].sort());
        break;
      }
      for (const d of ready) { out.push(d); left.delete(d); }
    }
    console.log(out.join("\n"));
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

DEPENDED_ON=$(depended_on_dirs)

needed_by_publish() {
  printf '%s\n' "$DEPENDED_ON" | grep -qxF "$1"
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

pkg_field() {
  node -e "
    const p = require('./$1/package.json');
    process.stdout.write(String(p['$2'] ?? ''));
  "
}

# Publish one package. Tries OIDC trusted publishing first (no .npmrc exists,
# so npm detects the absent auth plus the id-token environment and exchanges
# for a short-lived publish token). Falls back to NPM_TOKEN only when the
# registry says we are unauthenticated — a build failure or a version conflict
# must not silently retry with a different credential.
publish_one() {
  local dir="$1" name="$2" out rc npmrc

  out=$(cd "$dir" && npm publish --access public --provenance 2>&1)
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
  out=$(cd "$dir" && NPM_CONFIG_USERCONFIG="$npmrc" npm publish --access public --provenance 2>&1)
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
    out=$(cd "$dir" && NPM_CONFIG_USERCONFIG="$npmrc" npm publish --access public 2>&1)
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

published=()
skipped=()
failed=()

while read -r dir; do
  [ -n "$dir" ] || continue

  if [ "$(pkg_field "$dir" private)" = "true" ]; then
    continue
  fi

  name=$(pkg_field "$dir" name)
  version=$(pkg_field "$dir" version)
  if [ -z "$name" ] || [ -z "$version" ]; then
    echo "::warning::$dir/package.json has no name or version — skipping"
    continue
  fi

  # An unpublished package returns nothing here, which correctly reads as
  # "not at $version yet" and falls through to publish.
  live=$(npm view "$name" version 2>/dev/null || true)

  echo "::group::$name@$version (published: ${live:-none})"
  if [ "$live" = "$version" ]; then
    # Skipping the publish is not the same as skipping the build. A dependent
    # later in the order compiles against this package's *generated* output,
    # and the only thing that produces it is a prepack — normally a side effect
    # of publishing. So a package that is already at $version leaves nothing on
    # disk, and the dependent fails on a module that was never built.
    #
    # That is not a corner case, it is every retry: chant-v0.34.0's rerun
    # published nothing, found k8s already at 0.34.0, skipped it, and helm
    # failed on `@intentius/chant-lexicon-k8s/generated/index` exactly as it had
    # the first time. A single-lexicon release hits the same wall.
    #
    # So build it anyway, but only when something being published needs it.
    if needed_by_publish "$dir"; then
      echo "  already at $version — building anyway, a package after it imports its output"
      if ! (cd "$dir" && npm run prepack >/dev/null 2>&1); then
        echo "::warning::$name is already published but its prepack failed; a dependent may not build"
      fi
    else
      echo "  already at $version, skipping"
    fi
    skipped+=("$name@$version")
  elif publish_one "$dir" "$name"; then
    published+=("$name@$version")
  else
    failed+=("$name@$version")
  fi
  echo "::endgroup::"
done < <(publishable_dirs)

summary() {
  echo "### npm publish"
  echo
  printf '| package | version | result |\n|---|---|---|\n'
  local entry
  for entry in "${published[@]:-}"; do
    [ -n "$entry" ] && printf '| `%s` | %s | published |\n' "${entry%@*}" "${entry##*@}"
  done
  for entry in "${skipped[@]:-}"; do
    [ -n "$entry" ] && printf '| `%s` | %s | already published |\n' "${entry%@*}" "${entry##*@}"
  done
  for entry in "${failed[@]:-}"; do
    [ -n "$entry" ] && printf '| `%s` | %s | **FAILED** |\n' "${entry%@*}" "${entry##*@}"
  done
}

summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "$GITHUB_STEP_SUMMARY"

echo
echo "published: ${#published[@]}  already published: ${#skipped[@]}  failed: ${#failed[@]}"

if [ ${#failed[@]} -gt 0 ]; then
  echo "::error::${#failed[@]} package(s) failed to publish: ${failed[*]}"
  exit 1
fi
