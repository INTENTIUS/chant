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
