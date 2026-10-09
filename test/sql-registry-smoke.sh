#!/usr/bin/env bash
set -euo pipefail

# Registry smoke test for @intentius/chant-lexicon-sql (#3641).
#
# Runs inside the image test/Dockerfile.smoke-sql-registry builds, where
# @intentius/chant and @intentius/chant-lexicon-sql are installed from the
# registry at one version into /smoke, not packed from the workspace. For each
# dialect, against the servers `chant emulator up --lexicon sql` starts:
#
#   chant build          the declarations build, and write <dialect>.sql
#   chant sql plan       an empty database plans as creates
#   chant run            ApplyOp applies the build; a second plan is "No changes."
#   chant import --from  the live schema imports; the import builds and plans
#                        as "No changes." against the server it came from
#   chant sql plan       one change is classified (ClickHouse: a sort-key
#                        change is refused, exit 2; Postgres: an added column
#                        is metadata only)
#
# The container needs the Docker socket, since `chant emulator up` runs the
# pinned servers on the host's daemon, and the host network, since that
# command probes them on localhost. Start it with `just smoke-sql-registry`.
#
# Env:
#   SQL_SMOKE_DB          ClickHouse database and Postgres schema the test owns;
#                         dropped before and after (default chant_registry_smoke)
#   SQL_SMOKE_CLICKHOUSE  ClickHouse host:port (default: chant-clickhouse's
#                         bridge address, port 8123)
#   SQL_SMOKE_POSTGRES    Postgres host:port (default: chant-postgres's bridge
#                         address, port 5432)
#   SQL_SMOKE_KEEP=1      leave the database and schema in place afterwards

DB="${SQL_SMOKE_DB:-chant_registry_smoke}"
if ! [[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "SQL_SMOKE_DB must be a lower-case SQL identifier, got '$DB'" >&2
  exit 1
fi

ROOT=/smoke
CHANT="$ROOT/node_modules/.bin/chant"
PG_USER=postgres
PG_PASSWORD=chant

PASS=0
FAIL=0
ERRORS=""
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  - $1"; }

# Run a command, keep its output in $OUT and its exit code in $CODE, and echo
# the output so a failure can be read in the log.
run() {
  set +e
  OUT=$("$@" 2>&1)
  CODE=$?
  set -e
  printf '%s\n' "$OUT" | sed 's/^/    | /'
}

# check <label> <expected exit> <grep -E pattern or empty>
check() {
  local label="$1" want="$2" pattern="${3:-}"
  if [ "$CODE" -ne "$want" ]; then
    fail "$label (exit $CODE, want $want)"
  elif [ -n "$pattern" ] && ! grep -qE -- "$pattern" <<<"$OUT"; then
    fail "$label (output lacks /$pattern/)"
  else
    pass "$label"
  fi
}

version_of() { node -p "require('$ROOT/node_modules/$1/package.json').version"; }

echo "=== sql registry smoke ==="
echo "  @intentius/chant              $(version_of @intentius/chant)"
echo "  @intentius/chant-lexicon-sql  $(version_of @intentius/chant-lexicon-sql)"
echo "  database / schema             $DB"

# The installed packages must be the registry's, not a workspace link.
for pkg in @intentius/chant @intentius/chant-lexicon-sql; do
  if [ -L "$ROOT/node_modules/$pkg" ]; then
    fail "$pkg is a symlink, not a registry install"
  else
    resolved=$(node -p "require('$ROOT/package-lock.json').packages['node_modules/$pkg'].resolved")
    if [[ "$resolved" == https://registry.npmjs.org/* ]]; then
      pass "$pkg resolved from $resolved"
    else
      fail "$pkg resolved from '$resolved', not the registry"
    fi
  fi
done

# ── Emulator ──────────────────────────────────────────────────────────────────

mkdir -p "$ROOT/emulator"
cd "$ROOT/emulator"
cat > chant.config.ts <<'EOF'
import type { ChantConfig } from "@intentius/chant";
export default { lexicons: ["sql"] } satisfies ChantConfig;
EOF

echo ""
echo "=== chant emulator up --lexicon sql ==="
run "$CHANT" emulator up --lexicon sql --json
check "chant emulator up --lexicon sql" 0 '"chant-clickhouse".*"chant-postgres"|"chant-postgres".*"chant-clickhouse"'
[ "$CODE" -eq 0 ] || { echo "emulator did not start"; exit 1; }

bridge_addr() { docker inspect -f '{{with index .NetworkSettings.Networks "bridge"}}{{.IPAddress}}{{end}}' "$1"; }
CH="${SQL_SMOKE_CLICKHOUSE:-$(bridge_addr chant-clickhouse):8123}"
PG="${SQL_SMOKE_POSTGRES:-$(bridge_addr chant-postgres):5432}"
echo "  ClickHouse at $CH, Postgres at $PG"

ch_sql() { docker exec chant-clickhouse clickhouse-client -q "$1"; }
pg_sql() { docker exec chant-postgres psql -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres -c "$1"; }

drop_all() {
  ch_sql "DROP DATABASE IF EXISTS $DB SYNC" || true
  pg_sql "DROP SCHEMA IF EXISTS $DB CASCADE" >/dev/null || true
}
drop_all
[ "${SQL_SMOKE_KEEP:-0}" = 1 ] || trap drop_all EXIT

# A project directory under /smoke, so its imports resolve to /smoke/node_modules.
new_project() {
  local dir="$ROOT/$1"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/ops"
  cd "$dir"
  # ApplyOp's build phase runs `npm run build`.
  cat > package.json <<EOF
{
  "name": "$1",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": { "build": "$CHANT build src --lexicon sql -o dist/schema.json" }
}
EOF
  # `chant run` needs a git repository.
  git init -q
}

apply_op() {
  cat > ops/schema-apply.op.ts <<EOF
import { ApplyOp } from "@intentius/chant/op";

const { op } = ApplyOp({ name: "schema-apply", env: "smoke", target: "$1" });

export default op;
EOF
}

# ── ClickHouse ────────────────────────────────────────────────────────────────

ch_config() {
  cat > chant.config.ts <<EOF
import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: { profiles: { smoke: { url: "http://$CH", databases: ["$DB"] } } },
} satisfies ChantConfig;
EOF
}

ch_source() {
  # $1 = the events table's ORDER BY
  cat > src/schema.ts <<EOF
import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const smokeDb = database\`CREATE DATABASE $DB ENGINE = Atomic\`;

export const events = table\`
  CREATE TABLE \${smokeDb}.events (
    user_id UInt64,
    kind    LowCardinality(String),
    ts      DateTime
  )
  ENGINE = MergeTree
  ORDER BY $1
  TTL ts + INTERVAL 180 DAY\`;

export const byKind = view\`
  CREATE VIEW \${smokeDb}.by_kind AS
  SELECT \${events.columns.kind} AS kind, count() AS n FROM \${events} GROUP BY kind\`;
EOF
}

echo ""
echo "=== ClickHouse ==="
new_project ch
ch_config
ch_source "(user_id, ts)"
apply_op clickhouse

echo "  -- chant build"
run "$CHANT" build src --lexicon sql -o dist/schema.json
check "clickhouse: chant build" 0
if [ -s dist/schema.json ] && grep -q "CREATE TABLE $DB.events" dist/clickhouse.sql 2>/dev/null; then
  pass "clickhouse: build wrote dist/schema.json and dist/clickhouse.sql"
else
  fail "clickhouse: build wrote dist/schema.json and dist/clickhouse.sql"
fi

echo "  -- chant sql plan (empty server)"
run "$CHANT" sql plan smoke dist/schema.json
check "clickhouse: plan against an empty server creates" 0 'SQLCH200'

echo "  -- chant run schema-apply"
run "$CHANT" run schema-apply
check "clickhouse: ApplyOp applies the build" 0 'applied 3 resource'

echo "  -- chant sql plan (after apply)"
run "$CHANT" sql plan smoke dist/schema.json
check "clickhouse: plan after apply" 0 'No changes\.'

echo "  -- chant import --from smoke"
new_project ch-import
ch_config
run "$CHANT" import --from smoke --output src/
check "clickhouse: chant import --from" 0
if grep -q 'table`' src/*.ts 2>/dev/null && grep -q 'view`' src/*.ts; then
  pass "clickhouse: import wrote a table and a view"
else
  fail "clickhouse: import wrote a table and a view"
fi
sed 's/^/    > /' src/*.ts 2>/dev/null || true
run "$CHANT" build src --lexicon sql -o dist/schema.json
check "clickhouse: imported schema builds" 0
[ -s dist/schema.json ] || fail "clickhouse: imported schema build wrote dist/schema.json"
run "$CHANT" sql plan smoke dist/schema.json
check "clickhouse: imported schema plans as no change" 0 'No changes\.'

echo "  -- chant sql plan (sort-key change)"
cd "$ROOT/ch"
ch_source "(ts, user_id)"
run "$CHANT" build src --lexicon sql -o dist/schema.json
check "clickhouse: changed schema builds" 0
run "$CHANT" sql plan smoke dist/schema.json
check "clickhouse: plan refuses a sort-key change (exit 2)" 2 'SQLCH220'

# ── Postgres ──────────────────────────────────────────────────────────────────

pg_config() {
  cat > chant.config.ts <<EOF
import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      smoke: {
        url: "postgres://$PG/postgres",
        user: { env: "SQL_SMOKE_PG_USER" },
        password: { env: "SQL_SMOKE_PG_PASSWORD" },
        schemas: ["$DB"],
      },
    },
  },
} satisfies ChantConfig;
EOF
}
export SQL_SMOKE_PG_USER="$PG_USER" SQL_SMOKE_PG_PASSWORD="$PG_PASSWORD"

pg_source() {
  # $1 = an extra column line for orders, or empty
  cat > src/schema.ts <<EOF
import { schema, table, index, view } from "@intentius/chant-lexicon-sql/postgres";

export const smokeSchema = schema\`CREATE SCHEMA $DB\`;

export const users = table\`
  CREATE TABLE \${smokeSchema}.users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE
  )\`;

export const orders = table\`
  CREATE TABLE \${smokeSchema}.orders (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES \${users} (\${users.columns.id}),$1
    amount  numeric(12,2) NOT NULL
  )\`;

export const ordersUserId = index\`
  CREATE INDEX orders_user_id_idx ON \${orders} (\${orders.columns.user_id})\`;

export const orderTotals = view\`
  CREATE VIEW \${smokeSchema}.order_totals AS
  SELECT o.\${orders.columns.user_id} AS user_id, sum(o.\${orders.columns.amount}) AS total
  FROM \${orders} o GROUP BY o.\${orders.columns.user_id}\`;
EOF
}

echo ""
echo "=== Postgres ==="
new_project pg
pg_config
pg_source ""
apply_op postgres

echo "  -- chant build"
run "$CHANT" build src --lexicon sql -o dist/schema.json
check "postgres: chant build" 0
if [ -s dist/schema.json ] && grep -q "CREATE TABLE $DB.orders" dist/postgres.sql 2>/dev/null; then
  pass "postgres: build wrote dist/schema.json and dist/postgres.sql"
else
  fail "postgres: build wrote dist/schema.json and dist/postgres.sql"
fi

echo "  -- chant sql plan (empty schema)"
run "$CHANT" sql plan smoke dist/schema.json
check "postgres: plan against an empty schema creates" 0 'SQLPG200'

echo "  -- chant run schema-apply"
run "$CHANT" run schema-apply
check "postgres: ApplyOp applies the build" 0 'applied 5 resource'

echo "  -- chant sql plan (after apply)"
run "$CHANT" sql plan smoke dist/schema.json
check "postgres: plan after apply" 0 'No changes\.'

echo "  -- chant import --from smoke"
new_project pg-import
pg_config
run "$CHANT" import --from smoke --output src/
check "postgres: chant import --from" 0
if grep -q 'table`' src/*.ts 2>/dev/null && grep -q 'index`' src/*.ts && grep -q 'view`' src/*.ts; then
  pass "postgres: import wrote tables, an index and a view"
else
  fail "postgres: import wrote tables, an index and a view"
fi
sed 's/^/    > /' src/*.ts 2>/dev/null || true
run "$CHANT" build src --lexicon sql -o dist/schema.json
check "postgres: imported schema builds" 0
[ -s dist/schema.json ] || fail "postgres: imported schema build wrote dist/schema.json"
run "$CHANT" sql plan smoke dist/schema.json
check "postgres: imported schema plans as no change" 0 'No changes\.'

echo "  -- chant sql plan (added column)"
cd "$ROOT/pg"
pg_source "
    note    text,"
run "$CHANT" build src --lexicon sql -o dist/schema.json
check "postgres: changed schema builds" 0
run "$CHANT" sql plan smoke dist/schema.json
check "postgres: plan classifies an added column as metadata only" 0 'SQLPG201'

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== sql registry smoke: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo -e "Failures:$ERRORS"
  exit 1
fi
