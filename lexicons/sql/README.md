# @intentius/chant-lexicon-sql

SQL lexicon for [chant](https://github.com/INTENTIUS/chant): database schema as typed declarations, one database dialect at a time. ClickHouse is the first dialect, at `@intentius/chant-lexicon-sql/clickhouse`.

chant is spec-true per dialect, not database-agnostic. A dialect's engines, column types, codecs and settings are that database's own, read from a pinned server, and its change rules are that database's `ALTER` restrictions. There is no neutral schema model between dialects.

This package is being built in slices under [#3199](https://github.com/INTENTIUS/chant/issues/3199) and is not published yet. What it holds today:

- The ClickHouse type catalog: engine, type family, codec, skip index, format and function names and both settings surfaces, generated from the `system.*` tables of `clickhouse/clickhouse-server:26.8.15.10` and committed as `src/spec/clickhouse-catalog.snapshot.json`.
- Hand-written overlays for the grammar the catalog does not carry: engine argument kinds, column type parameters, codec parameters, skip index parameters, TTL actions and projection forms (`src/clickhouse/overlays/`).

Tables, views and materialized views declared as SQL-shaped tagged templates, import from a live server and the offline change classifier follow in #3197.

## Generating

`npm run generate` reads the committed snapshot; no Docker or network is needed. Moving the pin (`src/spec/pin.ts`) makes generation start the pinned server in a throwaway container and rewrite the snapshot. See `docs/pages/clickhouse-catalog.mdx`.

## Rule ids

`SQL` prefixes every rule this lexicon ships. Rules that hold in every dialect are `SQL` plus three digits; the ClickHouse dialect's are `SQLCH` plus three digits.
