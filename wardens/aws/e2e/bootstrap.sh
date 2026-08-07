#!/usr/bin/env bash
# Stand up a floci (AWS emulator) container for the aws-warden e2e suite and
# emit the env the suite needs. Mirrors the gitlab/forgejo warden pattern: no
# credentials, fully hermetic.
#
# floci 1.5.34 ships NO organizations service (test/floci-gaps.md entry 5), so
# this probes health for it and — when absent — exits 0 WITHOUT exporting
# AWS_ENDPOINT_URL: the suite self-skips green with the notice below rather
# than failing nightly on a known emulator gap.
set -euo pipefail

NAME="${FLOCI_NAME:-aws-warden-e2e-floci}"
PORT="${FLOCI_PORT:-4566}"
IMAGE="${FLOCI_IMAGE:-floci/floci:1.5.34}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:4566" "$IMAGE" >/dev/null

health=""
for _ in $(seq 1 30); do
  health=$(curl -sf "http://localhost:$PORT/_localstack/health" || true)
  [ -n "$health" ] && break
  sleep 2
done

if ! echo "$health" | grep -q '"organizations"'; then
  echo "floci at :$PORT has no organizations service — aws-warden e2e will self-skip" >&2
  echo "(known emulator gap: test/floci-gaps.md entry 5)" >&2
  exit 0
fi

{
  echo "AWS_ENDPOINT_URL=http://localhost:$PORT"
  echo "AWS_ACCESS_KEY_ID=test"
  echo "AWS_SECRET_ACCESS_KEY=test"
  echo "AWS_REGION=us-east-1"
} >> "${GITHUB_ENV:-/dev/stdout}"
