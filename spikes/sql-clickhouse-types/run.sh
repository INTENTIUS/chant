#!/usr/bin/env bash
# Usage: run.sh <image-tag> <out-file>   (run through .docker-slot.sh)
# Starts a throwaway clickhouse-server, generates the types file, always removes the container.
set -u
TAG="$1"; OUT="$2"
NAME="chant-sql-spike-$$-$RANDOM"
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT INT TERM
docker run -d --name "$NAME" ${DOCKER_EXTRA:-} -p 127.0.0.1::8123 -e CLICKHOUSE_SKIP_USER_SETUP=1 \
  "clickhouse/clickhouse-server:$TAG" >/dev/null || exit 1
PORT=$(docker port "$NAME" 8123/tcp | head -1 | sed 's/.*://')
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/ping" >/dev/null && break; sleep 1; done
CH_URL="http://127.0.0.1:$PORT" node "$(dirname "$0")/generate.mjs" "$OUT"
