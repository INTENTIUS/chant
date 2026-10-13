/**
 * `chant init --lexicon sql` scaffolds, all ClickHouse.
 *
 * - default: a database, one MergeTree table and a view that reads it.
 * - `events`: an events table with a partition key and a TTL, and a rollup
 *   (an AggregatingMergeTree target and the materialized view that fills it).
 * - `cdc`: a mirror of an upstream table kept by a CDC feed: a
 *   ReplacingMergeTree table with a version column and a delete flag, and a
 *   view of the current rows.
 *
 * Each builds with the sql lexicon alone and passes its post-synth checks.
 */
import type { InitTemplateSet } from "@intentius/chant/lexicon";

const DATABASE = (name: string, comment: string) => `import { database } from "@intentius/chant-lexicon-sql/clickhouse";

export const ${name} = database\`
  CREATE DATABASE ${name}
  ENGINE = Atomic
  COMMENT '${comment}'\`;
`;

// ── default ────────────────────────────────────────────────────────────

const DEFAULT_TABLES = `import { table } from "@intentius/chant-lexicon-sql/clickhouse";
import { shop } from "./database";

// Orders land here. The sort key is the on-disk order of every part, and it
// cannot be changed in place later, so choose it for the queries you run.
export const orders = table\`
  CREATE TABLE \${shop}.orders (
    id          UInt64,
    customer_id UInt64,
    status      LowCardinality(String),
    total       Decimal(18, 2),
    created_at  DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(created_at)
  ORDER BY (customer_id, created_at, id)\`;
`;

const DEFAULT_VIEWS = `import { view } from "@intentius/chant-lexicon-sql/clickhouse";
import { shop } from "./database";
import { orders } from "./orders";

// Columns are referenced through .columns, which records the view's lineage.
export const openOrders = view\`
  CREATE VIEW \${shop}.open_orders AS
  SELECT
    \${orders.columns.id} AS id,
    \${orders.columns.customer_id} AS customer_id,
    \${orders.columns.total} AS total
  FROM \${orders}
  WHERE \${orders.columns.status} = 'open'\`;
`;

export const DEFAULT_TEMPLATE: InitTemplateSet = {
  src: {
    "database.ts": DATABASE("shop", "Orders and customers"),
    "orders.ts": DEFAULT_TABLES,
    "views.ts": DEFAULT_VIEWS,
  },
};

// ── events ─────────────────────────────────────────────────────────────

const EVENTS_TABLE = `import { table } from "@intentius/chant-lexicon-sql/clickhouse";
import { analytics } from "./database";

// Raw events, kept 90 days. The TTL is a background rewrite when changed
// (chant sql plan reports it as SQLCH205).
export const events = table\`
  CREATE TABLE \${analytics}.events (
    user_id  UUID,
    kind     LowCardinality(String),
    ts       DateTime CODEC(Delta, ZSTD(3)),
    props    Map(String, String)
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (kind, user_id, ts)
  TTL ts + INTERVAL 90 DAY\`;
`;

const EVENTS_ROLLUP = `import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";
import { analytics } from "./database";
import { events } from "./events";

// Hourly counts and distinct users per kind. The rollup outlives the raw
// events: it has no TTL.
export const hourly = table\`
  CREATE TABLE \${analytics}.events_hourly (
    hour   DateTime,
    kind   LowCardinality(String),
    n      SimpleAggregateFunction(sum, UInt64),
    users  AggregateFunction(uniq, UUID)
  )
  ENGINE = AggregatingMergeTree
  PARTITION BY toYYYYMM(hour)
  ORDER BY (kind, hour)\`;

// The target of a materialized view is fixed when the view is created.
export const hourlyMv = view\`
  CREATE MATERIALIZED VIEW \${analytics}.events_hourly_mv TO \${hourly} AS
  SELECT
    toStartOfHour(\${events.columns.ts}) AS hour,
    \${events.columns.kind} AS kind,
    count() AS n,
    uniqState(\${events.columns.user_id}) AS users
  FROM \${events}
  GROUP BY hour, kind\`;
`;

export const EVENTS_TEMPLATE: InitTemplateSet = {
  src: {
    "database.ts": DATABASE("analytics", "Product analytics"),
    "events.ts": EVENTS_TABLE,
    "rollup.ts": EVENTS_ROLLUP,
  },
};

// ── cdc ────────────────────────────────────────────────────────────────

const CDC_TABLE = `import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";
import { mirror } from "./database";

// A mirror of an upstream customers table. The CDC feed inserts a row per
// change with a rising _version, and a delete as a row with _deleted = 1.
// ReplacingMergeTree keeps the highest _version per sort key at merge time,
// and the engine arguments cannot be changed in place later.
export const customers = table\`
  CREATE TABLE \${mirror}.customers (
    id          UInt64,
    email       String,
    plan        LowCardinality(String) DEFAULT 'free',
    _version    UInt64,
    _deleted    UInt8 DEFAULT 0
  )
  ENGINE = ReplacingMergeTree(_version, _deleted)
  ORDER BY id\`;

// Merges are eventual, so read through FINAL (or this view) for the current rows.
export const customersCurrent = view\`
  CREATE VIEW \${mirror}.customers_current AS
  SELECT
    \${customers.columns.id} AS id,
    \${customers.columns.email} AS email,
    \${customers.columns.plan} AS plan
  FROM \${customers} FINAL\`;
`;

export const CDC_TEMPLATE: InitTemplateSet = {
  src: {
    "database.ts": DATABASE("mirror", "Replicated from the upstream database"),
    "customers.ts": CDC_TABLE,
  },
};

// ── Postgres ───────────────────────────────────────────────────────────
//
// `--template postgres`, `postgres-tenant` and `postgres-events`. Each builds
// with the sql lexicon alone and lints clean.

const PG_SCHEMA = (name: string, comment: string) => `import { schema } from "@intentius/chant-lexicon-sql/postgres";

export const ${name} = schema\`
  CREATE SCHEMA ${name};
  COMMENT ON SCHEMA ${name} IS '${comment}'\`;
`;

const PG_USERS = `import { table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema";

export const users = table\`
  CREATE TABLE \${app}.users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE \${app}.users IS 'One row per account'\`;
`;

const PG_ORDERS = `import { index, table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema";
import { users } from "./users";

// The foreign key is a reference: orders is created after users.
export const orders = table\`
  CREATE TABLE \${app}.orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES \${users} (\${users.columns.id}) ON DELETE CASCADE,
    status     text NOT NULL DEFAULT 'placed',
    amount     numeric(12, 2) NOT NULL CHECK (amount >= 0),
    placed_at  timestamptz NOT NULL DEFAULT now()
  )\`;

// Postgres does not index a foreign key for you. An index needs a name: the
// name is its identity on the server.
export const ordersUser = index\`
  CREATE INDEX orders_user_id_idx ON \${orders} (\${orders.columns.user_id}, \${orders.columns.placed_at} DESC)\`;
`;

const PG_VIEWS = `import { view } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema";
import { orders } from "./orders";
import { users } from "./users";

// Columns are referenced through .columns, which records the view's lineage.
export const orderTotals = view\`
  CREATE VIEW \${app}.order_totals WITH (security_invoker = true) AS
  SELECT u.\${users.columns.id} AS user_id,
         count(o.\${orders.columns.id}) AS order_count,
         coalesce(sum(o.\${orders.columns.amount}), 0) AS total
  FROM \${users} u
  LEFT JOIN \${orders} o ON o.\${orders.columns.user_id} = u.\${users.columns.id}
  GROUP BY u.\${users.columns.id}\`;
`;

export const POSTGRES_TEMPLATE: InitTemplateSet = {
  src: {
    "schema.ts": PG_SCHEMA("app", "Accounts and orders"),
    "users.ts": PG_USERS,
    "orders.ts": PG_ORDERS,
    "views.ts": PG_VIEWS,
  },
};

const TENANT_TABLES = `import { table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema";

export const tenants = table\`
  CREATE TABLE \${app}.tenants (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug text NOT NULL UNIQUE
  )\`;

// Every tenant-owned table carries tenant_id and leads its primary key with it,
// so a tenant's rows sit together and the key doubles as the tenant's index.
export const projects = table\`
  CREATE TABLE \${app}.projects (
    tenant_id  bigint NOT NULL REFERENCES \${tenants} (\${tenants.columns.id}) ON DELETE CASCADE,
    id         bigint GENERATED ALWAYS AS IDENTITY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
  )\`;
`;

const TENANT_TASKS = `import { index, table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema";
import { projects } from "./tables";

// The foreign key carries the tenant too, so a task cannot point at another
// tenant's project.
export const tasks = table\`
  CREATE TABLE \${app}.tasks (
    tenant_id  bigint NOT NULL,
    id         bigint GENERATED ALWAYS AS IDENTITY,
    project_id bigint NOT NULL,
    title      text NOT NULL,
    done       boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES \${projects} (\${projects.columns.tenant_id}, \${projects.columns.id}) ON DELETE CASCADE
  )\`;

// Every index leads with the tenant key.
export const tasksProject = index\`
  CREATE INDEX tasks_project_idx ON \${tasks} (\${tasks.columns.tenant_id}, \${tasks.columns.project_id})\`;

export const tasksOpen = index\`
  CREATE INDEX tasks_open_idx ON \${tasks} (\${tasks.columns.tenant_id}, \${tasks.columns.id}) WHERE NOT \${tasks.columns.done}\`;
`;

export const POSTGRES_TENANT_TEMPLATE: InitTemplateSet = {
  src: {
    "schema.ts": PG_SCHEMA("app", "Multi-tenant application data"),
    "tables.ts": TENANT_TABLES,
    "tasks.ts": TENANT_TASKS,
  },
};

const PG_EVENTS_TABLE = `import { index, table } from "@intentius/chant-lexicon-sql/postgres";
import { analytics } from "./schema";

// Partitioned by month. A primary key on a partitioned table must include the
// partition key, hence (id, occurred_at).
export const events = table\`
  CREATE TABLE \${analytics}.events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    kind        text NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (id, occurred_at)
  ) PARTITION BY RANGE (occurred_at)\`;

// An index on the parent is created on every partition.
export const eventsKind = index\`
  CREATE INDEX events_kind_idx ON \${events} (\${events.columns.kind}, \${events.columns.occurred_at})\`;
`;

const PG_EVENTS_PARTITIONS = `import { table } from "@intentius/chant-lexicon-sql/postgres";
import { analytics } from "./schema";
import { events } from "./events";

// One partition per month, bounds [from, to). Add the next month ahead of time:
// a row with no partition is an error.
export const events202601 = table\`
  CREATE TABLE \${analytics}.events_2026_01 PARTITION OF \${events}
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')\`;

export const events202602 = table\`
  CREATE TABLE \${analytics}.events_2026_02 PARTITION OF \${events}
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')\`;

export const events202603 = table\`
  CREATE TABLE \${analytics}.events_2026_03 PARTITION OF \${events}
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01')\`;
`;

export const POSTGRES_EVENTS_TEMPLATE: InitTemplateSet = {
  src: {
    "schema.ts": PG_SCHEMA("analytics", "Product analytics"),
    "events.ts": PG_EVENTS_TABLE,
    "partitions.ts": PG_EVENTS_PARTITIONS,
  },
};
