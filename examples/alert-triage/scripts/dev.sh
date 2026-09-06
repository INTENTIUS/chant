#!/usr/bin/env bash
# Bring up the alert-triage stack locally: the webhook receiver and one demo
# alert. No cloud, no cluster, no server — a triage is a `chant run`, so there
# is nothing standing between the webhook and the Op. Ctrl-C tears it down.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

PORT="${PORT:-8080}"
pids=()
cleanup() {
  echo
  echo "stopping..."
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

echo "▸ webhook receiver (POST http://localhost:${PORT}/alert)"
PORT="$PORT" npx tsx app/webhook.ts &
pids+=($!)
sleep 3

echo "▸ sending a demo alert"
WEBHOOK_URL="http://localhost:${PORT}/alert" npx tsx app/demo.ts || true

cat <<EOF

✓ stack up

  send another alert:  npm run alert
  drift (2nd source):  npm run drift -- --demo
  read the proposal:   cat .chant/triage/current.json
  clear the gate:      chant approve triage approve-remediation --approver you
  then apply it:       chant run triage

Ctrl-C to stop.
EOF
wait
