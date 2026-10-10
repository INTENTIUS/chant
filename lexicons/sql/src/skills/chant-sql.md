---
skill: chant-sql
description: Declare ClickHouse databases, tables, views, materialized views, dictionaries and functions as SQL-shaped tagged templates, with references, lineage and the checks that run on them
user-invocable: true
---
# Declaring a ClickHouse schema with chant

Use this skill when a project holds ClickHouse DDL: a database, tables, views, materialized views. The sql lexicon is spec-true to ClickHouse at its pinned server release. It is not a database-agnostic model: engine names, column types, codecs and settings are the pinned server's own, and a name the server does not have fails at build.

An object is declared as its own DDL inside a `database`, `table` or `view` tagged template from the dialect subpath. `chant build` parses the template when it folds the file, without running it, and turns it into one entity.

```ts
import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const analytics = database`CREATE DATABASE analytics ENGINE = Atomic`;

export const events = table`
  CREATE TABLE ${analytics}.events (
    user_id  UUID,
    kind     LowCardinality(String),
    ts       DateTime CODEC(Delta, ZSTD(3))
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (user_id, kind, ts)`;

export const byKind = view`
  CREATE VIEW ${analytics}.by_kind AS
  SELECT ${events.columns.kind} AS kind, count() AS n
  FROM ${events}
  GROUP BY kind`;
```

The export name (`events`) is the object's identity in chant. The name in the SQL (`analytics.events`) is its name in the database. A materialized view is a `view` template holding `CREATE MATERIALIZED VIEW`.

A dictionary is a `dictionary` template holding `CREATE DICTIONARY`, with its attributes, `PRIMARY KEY`, `SOURCE`, `LAYOUT` and `LIFETIME`. Its attributes are columns (`${ratesDict.columns.rate}`). Any change but its comment is SQLCH245, and the applier replaces it with `CREATE OR REPLACE DICTIONARY`. Keep passwords out of `SOURCE`: name a server-side named collection instead.

A SQL user-defined function is a `func` template holding `CREATE FUNCTION name AS (x) -> expr`, with no database in its name. A changed expression is SQLCH260 (`CREATE OR REPLACE FUNCTION`). It carries no ownership marker, so chant never drops one.

Users, roles, row policies and grants are `user`, `role`, `policy` and `grant` templates. Never write a password: `IDENTIFIED BY` is refused, a user declared without `IDENTIFIED` is created by the environment with its password, and chant manages the rest of it. Grants are compared per grantee: every `grant` naming a grantee adds up to its complete list, and anything else it holds is revoked (SQLCH274). None of these is ever dropped by chant. They are planned and applied only where the profile sets `access: true` (`sql.profiles.<env>.access`); elsewhere each is reported `filtered`.

## Interpolations

| Value | Means | Renders as |
|---|---|---|
| a `database`, `table` or `view` entity | a reference to that object | its name, database-qualified when the DDL qualifies it |
| `entity.columns.<name>` | a reference to one column | the column's name |
| a string | SQL text, spliced in before the statement is parsed | itself |
| a number, bigint, boolean or `null` | a literal | `42`, `true`, `NULL` |
| `literal(value)` | a string literal | `'quoted and escaped'` |

Reach columns through `.columns` and only there. `${events.kind}` is the entity's own field (the string `"resource"`), and `${events.user_id}` is `undefined`, which the tag refuses.

A plain string is SQL text, so a composite can supply a type, an engine or an expression. When a string is a value, wrap it in `literal()`: `DEFAULT ${literal(plan)}` writes `DEFAULT 'free'`, where `DEFAULT ${plan}` writes `DEFAULT free`, a column called `free`.

## What the build records

References become dependency edges. A view is created after the tables it reads, a materialized view after its `TO` target, a table after its database. The build output lists objects in that order as `applyOrder` and writes every statement, in the same order, to `clickhouse.sql` next to the JSON document.

A view's lineage is recorded per output column of its top-level select list, from the column references in it. Write `${events.columns.kind}` rather than bare `kind` where you want that edge recorded; a column named inside the SQL text is not a reference.

## Materialized views

A rollup is a target table plus a materialized view writing to it with `TO`:

```ts
export const daily = table`
  CREATE TABLE ${analytics}.daily (
    day    Date,
    kind   LowCardinality(String),
    users  AggregateFunction(uniq, UUID)
  )
  ENGINE = AggregatingMergeTree
  ORDER BY (day, kind)`;

export const dailyMv = view`
  CREATE MATERIALIZED VIEW ${analytics}.daily_mv TO ${daily} AS
  SELECT toDate(${events.columns.ts}) AS day, ${events.columns.kind} AS kind, uniqState(${events.columns.user_id}) AS users
  FROM ${events}
  GROUP BY day, kind`;
```

A materialized view's `TO` target is fixed when the view is created. Changing it later is a rebuild, see the `chant-sql-plan` skill.

## Composites

`@intentius/chant-lexicon-sql/clickhouse` exports five composites for tables that are usually declared the same way. Each is built from the `table` and `view` tags, and each prop is SQL text spliced into the template:

| Composite | Members | What it is |
|---|---|---|
| `ReplacingTable` | `table` | ReplacingMergeTree with a version column (`version`, UInt64 by default) |
| `EventsTable` | `table` | MergeTree partitioned by its timestamp (`ts`), with a TTL (`ttlDays`, default 90) and `ttl_only_drop_parts` |
| `RollupView` | `table`, `view` | A target table (SummingMergeTree by default) and a materialized view writing to it from `source` |
| `CdcMirror` | `table`, `current` | ReplacingMergeTree(`_version`, `_is_deleted`) for a CDC feed, and a view of its live rows |
| `ShardedTable` | `local`, `distributed` | ReplicatedMergeTree `ON CLUSTER` and the Distributed table over it |

```ts
import { EventsTable, RollupView } from "@intentius/chant-lexicon-sql/clickhouse";

export const events = EventsTable({ name: "events", columns: "user_id UUID, kind LowCardinality(String)", orderBy: "(kind, user_id, ts)", ttlDays: 30 });
```

Put a composite whose props reference another call's member (`source: events.table`) in its own file; a same-file reference to a composite call's member makes the file run instead of fold. Alias each item of a `RollupView` select list to a target column, or SQLCH110 reports it.

When chant interprets a composite's factory at build time, each field records the parameter it came from, so drift on `ttl` is reported as a change to `ttlDays`. Chant interprets a factory only from a project file, or from a package path a tsconfig `paths` entry maps to source, and only from the module that defines it. A composite imported from the installed package records its fields as `unknown`.

## Checks

| Id | When | What it flags |
|---|---|---|
| SQLCH001 | lint | the DDL does not parse, or the tag holds a different statement |
| SQLCH002 | lint | a `Nullable` column in the sort key or primary key, which ClickHouse refuses without `allow_nullable_key` |
| SQLCH003 | lint | `${events.kind}` where `${events.columns.kind}` was meant |
| SQLCH101 | build | an engine the pinned ClickHouse server does not have |

## Commands

```bash
chant lint src
chant build src --lexicon sql -o dist/schema.json
```

`chant init --lexicon sql` scaffolds a project. `--template events` adds an events table with a TTL and a rollup, and `--template cdc` a ReplacingMergeTree mirror table.

## Not covered

`CREATE TABLE ... AS` and `CREATE TABLE ... AS SELECT` are not declared with the tags. Dictionaries, functions, named collections and access control are not modelled. A second dialect is not supported.

Note that `chant migrate` does not run schema migrations. Schema changes go through `chant sql plan`, apply and the rebuild Op, described in the `chant-sql-plan` and `chant-sql-rebuild` skills.
