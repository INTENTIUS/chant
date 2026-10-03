---
skill: chant-sql-postgres-plan
description: Plan Postgres schema changes with chant sql diff and chant sql plan, and read the change classes (metadata only, validates, needs CONCURRENTLY, ACCESS EXCLUSIVE rewrite, expand and contract) as the lock each takes in production
user-invocable: true
---
# Planning Postgres schema changes

Use this skill when a declared Postgres schema changes and you need to know what the change does to a running server before anything runs. It covers the offline diff, the plan against a live server and the classifier behind both. Applying a plan is not on main yet: it comes with the Postgres applier (#3280), and this skill gets that section then. The expand-and-contract migration Op (#3281) has its own skill later.

The classes are Postgres's own. A change is classified by the lock it takes and whether it reads or rewrites the table, so the class answers the production question: will this queue behind running queries, block writes, or fail?

## Two commands

```bash
chant sql diff base.json head.json     # two chant build outputs, offline
chant sql plan prod dist/schema.json   # a build output against the prod server
```

`chant sql diff` compares a pull request's base and head builds and needs no server. `chant sql plan <env>` reads the server that `sql.profiles.<env>` binds, and compares the build with it. Add `--json` to either for a machine-readable report. The build output's `dialect` decides which classifier runs; a Postgres build gets the one described here.

Both exit 2 when any change can only be made as expand and contract, and 0 otherwise, so either can gate a pipeline. A plan refuses such a change: it is never one statement.

```ts
// chant.config.ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    postgresMajor: 16,
    provider: "rds",
    profiles: {
      prod: {
        url: "postgres://db.internal:5432/shop",
        user: { env: "PGUSER" },
        password: { env: "PG_PROD_PASSWORD" },
        schemas: ["app"],
        defaultSchema: "app",
      },
    },
  },
} satisfies ChantConfig;
```

Credentials are named by environment variable and never written into the URL. `schemas` limits what the plan reads to those schemas, and `defaultSchema` is where an unqualified declaration lives (`public` when omitted). Without a profile, `POSTGRES_URL`, `POSTGRES_USER` and `POSTGRES_PASSWORD` bind.

## sql.postgresMajor

`sql.postgresMajor` is the major the project targets (14 to 18); without it the newest supported major is used. The plan reads it, so set it to the server's major. It changes a classification where the majors differ:

- changing a STORED generated column's expression (SQLPG212) is a rewrite from 17 on; on 14 to 16 there is no `SET EXPRESSION`, so the column is dropped and added and the change is expand and contract;
- changing a table's access method (SQLPG226) is a rewrite from 15 on; on 14 it is expand and contract.

The post-synth checks SQLPG114 to SQLPG116 read the same setting.

## The change classes

| Class | Report label | What it means in production |
|---|---|---|
| create | create | a new object; nothing existing changes |
| metadata | metadata only | a catalog change; no row is read or written |
| validate | validates under a weaker lock | every row is read to check a constraint, but reads and writes go on |
| concurrently | needs CONCURRENTLY | an index build or drop that blocks writes unless it is done CONCURRENTLY |
| rewrite | ACCESS EXCLUSIVE rewrite or scan | the table is rewritten or read in full, and its reads and writes block until done |
| expand | EXPAND AND CONTRACT | no in-place change keeps old readers working; the plan refuses it |
| drop | drop | the object and, for a table, its data are gone |

Metadata only does not mean free. Most `ALTER TABLE` forms take `ACCESS EXCLUSIVE`, which queues behind every running query and then blocks every query behind it, so a short change can stall a busy table if a long transaction is open. The class says no rows move; the lock still has to be won.

## What the rules say

Every rule has an id in the SQLPG2xx range, names its class and cites the Postgres 18 documentation page behind it, with the differences across majors 14 to 18 where there are any. The full table is on the "Planning and the Change Classifier" page of the sql docs. The common cases:

| Change | Rule | Class | Notes |
|---|---|---|---|
| add a column, no default or a non-volatile default | SQLPG201 | metadata | the default is stored once, in every supported major |
| add a column with a volatile default, a STORED generated column or an identity column | SQLPG202 | rewrite | `gen_random_uuid()`, `random()`, `nextval()`, `clock_timestamp()` are volatile; `now()` is not |
| add a NOT NULL column with no default | SQLPG203 | expand | fails on a table with rows: add it nullable, backfill, then set NOT NULL |
| drop a column | SQLPG204 | metadata | the data is gone |
| rename a column | SQLPG205 | expand | old readers fail the moment it runs |
| column type to a binary-coercible type (longer varchar, text, wider numeric) | SQLPG206 | metadata | indexes on the column may still be rebuilt |
| column type with a rewrite (integer to bigint, a shorter varchar) | SQLPG207 | rewrite | |
| column type across kinds (text to integer) | SQLPG208 | expand | needs USING and breaks readers |
| set NOT NULL | SQLPG210 | rewrite | a valid `CHECK (col IS NOT NULL)` already in place makes it metadata |
| add a CHECK | SQLPG218 | rewrite | declare it `NOT VALID`, then validate |
| add a foreign key | SQLPG219 | validate | `SHARE ROW EXCLUSIVE` on both tables for the scan; `NOT VALID` first avoids it |
| add a constraint `NOT VALID` | SQLPG217 | metadata | checks new rows only |
| validate a constraint | SQLPG220 | validate | `SHARE UPDATE EXCLUSIVE`, so reads and writes go on |
| add a primary key or unique constraint | SQLPG221 | concurrently | build the unique index CONCURRENTLY, then `ADD CONSTRAINT ... USING INDEX` |
| create an index CONCURRENTLY | SQLPG240 | concurrently | cannot run inside a transaction block; a failed build leaves an INVALID index to drop |
| create an index without CONCURRENTLY on an existing table | SQLPG241 | concurrently | `SHARE` blocks every write until the build ends: declare it CONCURRENTLY |
| drop or change an index | SQLPG242, SQLPG243 | concurrently | a changed index is dropped and created |
| change a view's query, keeping its columns | SQLPG250 | metadata | |
| change a view's columns | SQLPG251 | expand | dropped and created, with every view on top of it |
| add an enum label | SQLPG260 | metadata | the new label cannot be used in the same transaction |
| remove or reorder enum labels | SQLPG261 | expand | a new type, columns moved, the old type dropped |
| change partitioning or inheritance | SQLPG227 | expand | a new table is filled and swapped in |
| rename an object or move it to another schema | SQLPG228 | expand | |
| drop an object | SQLPG270 | drop | |

A table created in the same plan as its indexes needs no CONCURRENTLY, so those indexes classify as create.

Two forms to prefer over the one-step version, because the rule names them:

- Adding a constraint that scans the table: declare it `NOT VALID` first (SQLPG217, metadata), then drop `NOT VALID` to validate it (SQLPG220, validate).
- Adding a unique key to a busy table: a named unique index `CONCURRENTLY` first, then the constraint over it.

## Identity and renames

Between two builds an object is its export name, so a changed SQL name under the same export is a rename. Against a server, which has no export names, an object is its qualified name (`app.orders`). A rename is expand and contract (SQLPG205, SQLPG228), so plan it deliberately. To tell the plan that a name changed rather than that one object was dropped and another created, put a comment before the CREATE:

```ts
export const orders = table`
  -- previously: purchases
  CREATE TABLE ${app}.orders (...)`;
```

A column is its name. Declare a column rename on its own line:

```ts
  status text NOT NULL, -- previously: state
```

Without the hint, a rename plans as a drop and an add, and the report says so when the two have the same type in the same place. A drop is destructive, so add the hint. An index renames in place (SQLPG229, metadata) and nothing reads an index by name.

## Objects that are not yours

Some objects on a server belong to another tool. The catalog reader marks them foreign, and the plan never proposes to drop them; it reports a hint that the object is kept by that tool and is left alone.

- ORM and migration-runner tables, by name: `_prisma_migrations` (Prisma Migrate), `django_migrations`, `alembic_version`, `__drizzle_migrations`, `flyway_schema_history`, `goose_db_version`, `knex_migrations`, `SequelizeMeta`, `pgmigrations`, `schema_migrations`, `ar_internal_metadata`.
- Provider-owned objects: with `sql.provider` (or a profile's `provider`) set, the provider's own schemas and extensions read as foreign, so a Supabase `auth` schema is not an orphan to drop.

A foreign object is not a change to approve. If a plan wants to drop something you did not declare and it is not marked foreign, it is yours to either declare or leave out of `schemas`.

## No false drift

The server prints DDL its own way (`format_type()`, schema-qualified names, normalized expressions, a constraint name it generated). The plan undoes those rewrites with normalization rules and asks the server about any expression the rules leave different, so formatting alone is not a change. A constraint the declaration leaves unnamed is matched by what it says, so the name Postgres gave it is not a change either. Name a constraint when a later migration must refer to it.

`chant lifecycle plan` reports each change's disruption: create and metadata are `in-place`; validate, concurrently and rewrite are `rolling`; expand and contract is `replace`; a drop is `destroy`. For a column, constraint, view or enum change the lifecycle plan reports `unknown`, because the class depends on both definitions; `chant sql plan` classifies those.

## Reading a plan in a pull request

1. `chant build src --lexicon sql -o head.json` on the pull request branch, and the same on the base branch into `base.json`.
2. `chant sql diff base.json head.json`.
3. Read the `Warning` line: it counts the rewrites, each of which blocks the table's reads and writes until done. The rule names the form that does not.
4. An exit of 2 means a refused change. Do not merge it as an ordinary change: it runs as expand and contract (add the new, write both, backfill, move readers, drop the old). For a column rename (SQLPG205) or a type change across kinds (SQLPG208) the report names the `PostgresMigrationOp` declaration to add (`migrationOps` in `--json`); run it with `chant run <name>` until it is done. The other expand-and-contract changes have no Op yet.

## Applying

The Postgres applier is not on main. Until #3280 lands, a plan is read-only: nothing here sends a statement to the server. Apply, the lock timeouts and transaction handling around it, and the prune rules are added to this skill with that change.

## Not covered

Roles, grants, policies, functions and triggers are not modelled, so a plan does not see them. `chant migrate` is not a schema migration runner.
