---
skill: chant-sql-plan
description: Plan ClickHouse schema changes with chant sql diff and chant sql plan, and read the three change classes (metadata only, background rewrite, rebuild) with the ALTER restriction behind each
user-invocable: true
---
# Planning and applying ClickHouse schema changes

Use this skill when a declared ClickHouse schema changes and you need to know what the change does to the server before anything runs. This skill covers what exists today: the offline diff, the plan against a live server, and the change classifier. The applier and the rebuild are described at the end with their current state.

## Two commands

```bash
chant sql diff base.json head.json     # two chant build outputs, offline
chant sql plan prod dist/schema.json   # a build output against the prod server
```

`chant sql diff` compares a pull request's base and head builds and needs no server. `chant sql plan <env>` reads the server that `sql.profiles.<env>` binds in `chant.config.ts`, and compares the build with it. Add `--json` to either for a machine-readable report.

Both exit 2 when any change needs a rebuild, and 0 otherwise, so either can gate a pipeline.

```ts
// chant.config.ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    profiles: {
      prod: {
        url: "https://clickhouse.example.com:8443",
        user: { env: "CH_USER" },
        password: { env: "CH_PROD_PASSWORD" },
        databases: ["analytics"],
      },
    },
  },
} satisfies ChantConfig;
```

Credentials are named by environment variable and never written into the config.

## The three change classes

| Class | Means | Examples |
|---|---|---|
| metadata only | the server records the change and touches no existing data | add a column (SQLCH201), change a default (SQLCH207), add a skip index (SQLCH204), rename a column outside the keys (SQLCH212), change a materialized view's query (SQLCH241) |
| background rewrite | a mutation rewrites existing parts in the background, with no rollback | change a TTL (SQLCH205), change the type of a column outside the primary key (SQLCH210) |
| rebuild | ClickHouse cannot make the change to the existing table; the data has to be copied into a new one | change the sorting key beyond appending new columns (SQLCH220), the partition key (SQLCH222), the engine or its arguments (SQLCH223), a materialized view's `TO` target (SQLCH242) |

Every rule has an id in the SQLCH2xx range, names its class, and cites the ClickHouse documentation page that states the restriction. The full table is on the "Planning and the Change Classifier" page of the sql docs, written from the rules, so read the page rather than recalling a class from memory.

Two classes of change are not what they look like:

- A metadata-only drop (SQLCH202) is not reversible: the column's data is removed from every part.
- A TTL change (SQLCH205) looks like metadata, but with `materialize_ttl_after_modify` on (the default) the server recalculates the TTL over existing data as a mutation.

`chant lifecycle plan` reports the same classification as each update's disruption: metadata only is `in-place`, a rewrite is `rolling`, a rebuild is `replace`. For a column type or a sorting key change the lifecycle plan reports `unknown`, since deciding needs the whole definition; `chant sql plan` classifies those.

## Identity and renames

Between two builds an object is its export name, so a changed SQL name under the same export is a rename (`RENAME TABLE`, metadata only on an Atomic database). Against a server, which has no export names, an object is `database.name`. To rename something the server already has, put a comment before its CREATE:

```sql
-- previously: events_raw
CREATE TABLE analytics.events (...)
```

A column is its name. Declare a rename on the column's own line:

```sql
event_kind LowCardinality(String), -- previously: kind
```

Without the hint, a rename plans as a drop and an add, and the report says so when the two have the same type and position. A drop is destructive, so add the hint.

## No false drift

The server rewrites DDL on `SHOW CREATE` (quoting, `INTERVAL 1 DAY` as `toIntervalDay(1)`, default codec levels, settings at their default). The plan undoes those rewrites with normalization rules, and asks the server's own formatter about any expression the rules leave different, so formatting alone is not reported as a change. `chant lifecycle diff <env> --live` reads property-level drift with the same normalization.

## Reading a plan in a pull request

1. `chant build src --lexicon sql -o head.json` on the pull request branch, and the same on the base branch into `base.json`.
2. `chant sql diff base.json head.json`.
3. A rebuild exits 2. Do not merge it as an ordinary change: the report names the `ClickHouseRebuildOp` declaration to add for each refused table (`rebuildOps` in `--json`), and the rebuild runs as that Op (`chant-sql-rebuild`).

## Using plans in Ops

The sql lexicon does not yet export step builders for these commands. Until it does, an Op can run them with `shell` and gate on the result:

```ts
import { Op, phase, build, shell, gate } from "@intentius/chant/op";

export default Op({
  name: "schema-plan",
  overview: "Build the schema, plan it against prod, stop for approval",
  phases: [
    phase("Plan", [
      build("src"),
      shell("chant sql plan prod dist/schema.json --json", { json: true }),
    ]),
    phase("Approve", [gate("approve-schema-plan")]),
  ],
});
```

Resolve the gate with `chant approve approve-schema-plan`. The MCP server's `op-run`, `op-status` and `op-signal` tools start and watch the same Op.

## Applying

`ApplyOp` with `target: "clickhouse"` applies a build (`dist/schema.json`) to the server `sql.profiles.<env>` binds, through the sql lexicon's `clickhouseApply`. It makes the metadata-only and background-rewrite changes with `ALTER`, waits on `system.mutations` for a rewrite, and stamps chant's ownership marker on each object's comment. It reports a rebuild as not attempted (`unsupported-kind`, with the rule and the ALTER restriction in the detail) and sends nothing for that object, and withholds a column drop unless the Op may delete (`delete: "owned-only"` or `"gated"`). Prune drops only objects whose comment carries the project's marker.

```typescript
import { ApplyOp } from "@intentius/chant/op";

const { op } = ApplyOp({ name: "schema-apply", env: "prod", target: "clickhouse", delete: "gated" });

export default op;
```

Read the run's not-attempted count before calling a schema converged. A rebuild is never applied in place; it runs as the rebuild migration Op.

`chant migrate` is not a schema migration runner. Schema changes go through plan, apply and the rebuild Op.
