#!/usr/bin/env bash
# Which workspace packages can actually publish over OIDC.
#
# npm matches a trusted-publisher record against the *workflow filename*, so
# this only produces a meaningful answer when run from publish.yml. Called
# from any other workflow it reports every package as missing, which is why it
# is wired into a job there rather than a standalone workflow.
#
# Informational. The publish job is what fails a bad release; this exists so
# a package missing its record is visible in seconds instead of surfacing as a
# bare ENEEDAUTH at release time (#1177, #1253).
#
# Never prints the GitHub id-token or the publish token a successful exchange
# returns. A successful exchange answers 201, not 200.
set -uo pipefail

REGISTRY="https://registry.npmjs.org"

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
  echo "No id-token permission in this job — cannot audit. Needs 'id-token: write'."
  exit 0
fi

ok=()
missing=()

for dir in packages/*/ lexicons/*/ wardens/*/; do
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
    echo "::warning::GitHub did not issue an id-token — audit incomplete"
    exit 0
  fi

  body=$(mktemp)
  status=$(curl -sS -o "$body" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $idtok" \
    "$REGISTRY/-/npm/v1/oidc/token/exchange/package/${name//\//%2f}" 2>/dev/null)

  case "$status" in
    2*) ok+=("$name");        printf '  ok       %s\n' "$name" ;;
    *)  missing+=("$name");   printf '  MISSING  %s  (HTTP %s: %s)\n' "$name" "$status" \
          "$(jq -r '.message // .error // "?"' "$body" 2>/dev/null)" ;;
  esac
  rm -f "$body"
done

summary() {
  echo "### npm trusted-publisher coverage"
  echo
  if [ ${#missing[@]} -eq 0 ]; then
    echo "All ${#ok[@]} publishable packages have a working record."
  else
    echo "${#missing[@]} package(s) have **no** trusted-publisher record and will fail to"
    echo "publish when their version next moves:"
    echo
    local m
    for m in "${missing[@]}"; do echo "- \`$m\`"; done
    echo
    echo "Fix: on npmjs.com open the package, then Settings, Trusted Publisher, and set"
    echo "repository \`INTENTIUS/chant\`, workflow \`publish.yml\`, environment empty."
  fi
}

summary
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && summary >> "$GITHUB_STEP_SUMMARY"

echo
echo "configured: ${#ok[@]}  missing: ${#missing[@]}"
