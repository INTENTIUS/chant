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

# Publish order. Every lexicon peer-depends on @intentius/chant, and the k8s
# lexicon declares @intentius/chant-k8s-client as an optional dependency
# (#1074) — npm tolerates an optional dependency that fails to resolve, so
# publishing the client ahead of the lexicon is what keeps `chant lifecycle
# diff --live` working for a registry install rather than silently degrading
# to holes. Everything else follows in directory order.
PRIORITY_DIRS=(packages/core packages/k8s-client)

is_priority() {
  local candidate="$1" d
  for d in "${PRIORITY_DIRS[@]}"; do
    [ "$d" = "$candidate" ] && return 0
  done
  return 1
}

# Every workspace directory that npm would actually publish, priority first.
# `private: true` packages (packages/test-utils) are skipped the same way npm
# would skip them.
publishable_dirs() {
  local dir
  for dir in "${PRIORITY_DIRS[@]}"; do
    [ -f "$dir/package.json" ] && echo "$dir"
  done
  for dir in packages/*/ lexicons/*/; do
    dir="${dir%/}"
    [ -f "$dir/package.json" ] || continue
    is_priority "$dir" && continue
    echo "$dir"
  done
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

  if [ -z "${NPM_TOKEN:-}" ]; then
    echo "  $name has no trusted-publisher record and NPM_TOKEN is not set — cannot publish"
    return $rc
  fi

  # No trusted-publisher record for this package yet. Configure the token in a
  # throwaway userconfig rather than on the command line so it never lands in
  # the process table, and scope it to this one publish so the packages that
  # DO have a record keep using trusted publishing.
  echo "  $name: no npm trusted-publisher record — retrying with NPM_TOKEN"
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
    echo "  already at $version, skipping"
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
