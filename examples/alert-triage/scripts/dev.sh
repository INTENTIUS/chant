#!/usr/bin/env bash
# Bring up the alert-triage stack locally: a Temporal dev server, the triage
# worker, the webhook receiver, and one demo alert. No cloud, no cluster — just
# Temporal in-process. Ctrl-C tears it all down.
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

echo "▸ Temporal dev server (UI http://localhost:8233)"
temporal server start-dev --ip 127.0.0.1 --port 7233 --ui-port 8233 \
  --namespace default --log-level error &
pids+=($!)
for _ in $(seq 1 30); do
  temporal operator namespace describe -n default >/dev/null 2>&1 && break
  sleep 1
done

echo "▸ triage worker"
npx tsx activities/worker.ts &
pids+=($!)
sleep 6

echo "▸ webhook receiver (POST http://localhost:${PORT}/alert)"
PORT="$PORT" npx tsx app/webhook.ts &
pids+=($!)
sleep 3

echo "▸ sending a demo alert"
WEBHOOK_URL="http://localhost:${PORT}/alert" npx tsx app/demo.ts || true

cat <<EOF

✓ stack up — open the Temporal UI: http://localhost:8233

  send another alert:  npm run alert
  drift (2nd source):  npm run drift -- --demo
  approve a held one:  temporal workflow signal -n default \\
                         --query "WorkflowType='alertTriage'" --name approve-remediation

Ctrl-C to stop.
EOF
wait
