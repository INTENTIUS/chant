#!/usr/bin/env bash
# Which workspace packages can actually publish over OIDC.
#
# npm matches a trusted-publisher record against the *workflow filename*, so
# this only produces a meaningful answer when run from publish.yml. Called
# from any other workflow it reports every package as missing, which is why it
# is wired into a job there rather than a standalone workflow.
#
# A gate (#3191). publish.yml's `publish` job needs this one, so a package
# with no working record stops the release before any package ships, instead
# of surfacing as a bare ENEEDAUTH after the others are already on npm
# (#1177, #1253, and chant-v0.81.0 in #2646).
#
# Exit status:
#   0  every publishable package has a working record, or the audit could not
#      run at all because GitHub issued no id-token (forks, a job without
#      `id-token: write`). That case is a warning, not a failure.
#   1  at least one package's exchange was refused (no record, a record that
#      does not match this workflow, or a package not on npm yet), or the
#      registry gave no usable answer for it.
#
# Never prints the GitHub id-token or the publish token a successful exchange
# returns. A successful exchange answers 201, not 200.
set -uo pipefail

REGISTRY="https://registry.npmjs.org"

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  # Forks and jobs without the permission: nothing can be checked, and a
  # missing check is not a missing record. Warn and let the job pass.
  echo "::warning::No id-token permission in this job — cannot audit. Needs 'id-token: write'."
  exit 0
fi

ok=()
missing=()
unknown=()

for dir in packages/*/ lexicons/*/; do
  [ -f "${dir}package.json" ] || continue
  name=$(node -e "
    try {
      const p = require('./${dir}package.json');
      if (!p.private) process.stdout.write(p.name ?? '');
    } catch (e) {}
  ")
  [ -n "$name" ] || continue

  idtok=$(curl -sS -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
    -H "Accept: application/json" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=npm:registry.npmjs.org" 2>/dev/null \
    | jq -r '.value // empty' 2>/dev/null)
  if [ -z "$idtok" ]; then
    # GitHub issuing no token at all is the same situation as above. Once
    # some packages have been checked, a token that stops coming is a
    # transient failure for this package, not a reason to forget the others.
    if [ $(( ${#ok[@]} + ${#missing[@]} + ${#unknown[@]} )) -eq 0 ]; then
      echo "::warning::GitHub did not issue an id-token — cannot audit"
      exit 0
    fi
    unknown+=("$name"); printf '  UNKNOWN  %s  (no id-token for this check)\n' "$name"
    continue
  fi

  body=$(mktemp)
  status=$(curl -sS -o "$body" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $idtok" \
    "$REGISTRY/-/npm/v1/oidc/token/exchange/package/${name//\//%2f}" 2>/dev/null)

  # 4xx is the registry refusing the exchange: no record, a record whose
  # claims do not match, or no such package. 5xx or no answer at all (curl
  # prints 000) says nothing about the record, so it is reported apart, but a
  # release still does not go out on a check nobody answered.
  reason=$(jq -r '.message // .error // "?"' "$body" 2>/dev/null || echo "?")
  case "$status" in
    2*) ok+=("$name");        printf '  ok       %s\n' "$name" ;;
    4*) missing+=("$name");   printf '  MISSING  %s  (HTTP %s: %s)\n' "$name" "$status" "$reason" ;;
    *)  unknown+=("$name");   printf '  UNKNOWN  %s  (HTTP %s: %s)\n' "$name" "${status:-none}" "$reason" ;;
  esac
  rm -f "$body"
done

summary() {
  echo "### npm trusted-publisher coverage"
  echo
  local m
  if [ ${#missing[@]} -eq 0 ] && [ ${#unknown[@]} -eq 0 ]; then
    echo "All ${#ok[@]} publishable packages have a working record."
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    echo "${#missing[@]} package(s) have **no** working trusted-publisher record. Nothing"
    echo "publishes until each has one:"
    echo
    for m in "${missing[@]}"; do echo "- \`$m\`"; done
    echo
    echo "Fix: on npmjs.com open the package, then Settings, Trusted Publisher, and set"
    echo "repository \`INTENTIUS/chant\`, workflow \`publish.yml\`, environment empty."
    echo "A package that is not on npm yet has to be published once by hand first."
    echo "Then push the release tag again at the same commit."
  fi
  if [ ${#unknown[@]} -gt 0 ]; then
    [ ${#missing[@]} -gt 0 ] && echo
    echo "The registry gave no usable answer for ${#unknown[@]} package(s), so their record"
    echo "could not be checked:"
    echo
    for m in "${unknown[@]}"; do echo "- \`$m\`"; done
    echo
    echo "Re-run the workflow's failed jobs once the registry answers."
  fi
}

summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "$GITHUB_STEP_SUMMARY"

echo
echo "configured: ${#ok[@]}  missing: ${#missing[@]}  unknown: ${#unknown[@]}"

if [ ${#missing[@]} -gt 0 ] || [ ${#unknown[@]} -gt 0 ]; then
  echo "::error::$(( ${#missing[@]} + ${#unknown[@]} )) package(s) cannot publish over OIDC: ${missing[*]:-} ${unknown[*]:-}"
  exit 1
fi
