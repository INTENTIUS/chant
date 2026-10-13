#!/usr/bin/env bash
# The human gate in front of chant's large suites: the end-to-end tests, the
# Docker smokes, the registry smokes, the runtime and cloud e2es, the helm
# survey and the benchmarks.
#
# Usage: scripts/human-gate.sh <suite name>
#
# These suites are not part of developing a change. A change merges on the
# fast gates (`just check`, which is the build, lint, unit tests and the
# lexicon contract), and the same fast checks are all that CI runs on a pull
# request or a push. A large suite runs only when a person starts it: here,
# by typing `run` at a terminal, and on GitHub with a workflow_dispatch
# (.github/workflows/large-suites.yml, helm-survey.yml).
#
# Exit codes:
#   0  a person typed `run`, or this is a GitHub Actions run
#   3  no terminal (a script, a pipe, a coding agent), or the person declined
set -uo pipefail

suite="${1:-this suite}"

# A run GitHub started. The large-suite workflows are workflow_dispatch only,
# so a person started it.
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  exit 0
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  cat >&2 <<EOF

STOP: \`${suite}\` is a large suite and only runs when a person starts it.

It is not part of developing a change. A coding agent must not run it, must
not work around this check (calling the script behind the recipe, faking a
terminal, setting variables), and must not wait for it or for anyone to run
it. Merge on the fast local gates (\`just check\`) and go on with the work.

A person who wants this suite runs \`just ${suite}\` in a real terminal and
types \`run\` at the prompt, or starts the matching workflow on GitHub.

EOF
  exit 3
fi

printf '\n%s is a large suite. It is not part of developing a change.\n' "$suite"
printf 'Type run to start it, anything else to stop: '
read -r answer || answer=""
if [ "$answer" = "run" ]; then
  exit 0
fi
echo "Not started." >&2
exit 3
