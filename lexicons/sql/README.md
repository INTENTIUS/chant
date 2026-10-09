# @intentius/chant-lexicon-sql

SQL lexicon for [chant](https://github.com/INTENTIUS/chant): database schema as typed declarations, one database dialect at a time. Two dialects ship: ClickHouse at `@intentius/chant-lexicon-sql/clickhouse` and Postgres at `@intentius/chant-lexicon-sql/postgres`.

```bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-sql
```

chant is spec-true per dialect, not database-agnostic. A dialect's engines, column types, codecs and settings are that database's own, read from a pinned server, and its change rules are that database's `ALTER` restrictions. There is no neutral schema model between dialects.

What the package holds:

- SQL-shaped tagged templates that parse each dialect's DDL at build time into entities, with references, dependency order and column-level lineage for views. ClickHouse has `database`, `table`, `view` and materialized views; Postgres has schemas, tables, indexes, views, materialized views, sequences, enum types, domains and extensions. `chant build` writes a JSON schema document and the statements, in creation order, to `clickhouse.sql` or `postgres.sql`.
- Lint at the token (SQLCH001 to SQLCH003, SQLPG001 to SQLPG004) and after the build (SQLCH101 to SQLCH120, SQLPG101 to SQLPG118), checked against what the pinned server accepts.
- Type catalogs generated from pinned servers and committed as snapshots: `clickhouse/clickhouse-server:26.8.15.10`'s `system.*` tables, and one Postgres server per major from 14 to 18, with hand-written overlays for the grammar a catalog does not carry.
- Composites for both dialects, among them events, audit-log, soft-delete and tenant tables, rollup and refreshed views, and a CDC mirror.

```ts
import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const events = table`
  CREATE TABLE events (user_id UUID, kind LowCardinality(String), ts DateTime)
  ENGINE = MergeTree ORDER BY (user_id, ts)`;

export const byKind = view`
  CREATE VIEW by_kind AS
  SELECT ${events.columns.kind} AS kind, count() AS n FROM ${events} GROUP BY kind`;
```

- `chant import --from <env>` writes a live server's schema as declarations; `describeResources` and `observeResourcesDeep` read the server `sql.profiles.<env>` binds, and `chant lifecycle diff <env> --live` reports drift on it.
- Every schema change classified before it runs: `chant sql diff <base.json> <head.json>` offline, `chant sql plan <env> <build.json>` against a server. A ClickHouse change is metadata only, a background rewrite or a rebuild, citing the `ALTER` restriction behind it; a Postgres change names the lock it takes. A rebuild is refused in place, and `chant sql plan` exits 2 on one.
- Applying through `ApplyOp`: `target: "clickhouse"` (`clickhouseApply`) and `target: "postgres"` (`postgresApply`, in transactions, with `CONCURRENTLY` outside them). A ClickHouse rebuild runs as `ClickHouseRebuildOp`; a Postgres column rename or type change as `PostgresMigrationOp`, expand and contract.

## Generating

`npm run generate` reads the committed snapshots; no Docker or network is needed. Moving a pin (`src/spec/pin.ts` for ClickHouse, `src/spec/postgres-pin.ts` for Postgres) makes generation start that server in a throwaway container and rewrite its snapshot. See `docs/pages/clickhouse-catalog.mdx` and `docs/pages/postgres-majors.mdx`.

## Rule ids

`SQL` prefixes every rule this lexicon ships. Rules that hold in every dialect are `SQL` plus three digits; the ClickHouse dialect's are `SQLCH` and the Postgres dialect's `SQLPG`, each plus three digits.
