---
skill: chant-sql-postgres
description: Declare Postgres schemas, tables, constraints, indexes, views, sequences, enum and domain types and extensions as SQL-shaped tagged templates, with references, lineage and the SQLPG lint rules
user-invocable: true
---
# Declaring a Postgres schema with chant

Use this skill when a project holds Postgres DDL. The sql lexicon's Postgres dialect is spec-true: the statements are Postgres's own, parsed at build time without running them, and names fold and quote as Postgres folds and quotes them. It is not a database-agnostic model. A project holds one dialect; the ClickHouse dialect has its own skills (`chant-sql` and the two after it) and none of them applies here.

Import the tags from the `/postgres` subpath. Each template is one `CREATE` statement, optionally followed by `COMMENT ON` statements for the same object.

```ts
import { schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`CREATE SCHEMA app`;

export const users = table`
  CREATE TABLE ${app}.users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE ${app}.users IS 'One row per account'`;
```

The export name (`users`) is the object's identity in chant. The name in the SQL (`app.users`) is its name in the database. An unquoted name folds to lower case, so `CREATE TABLE Users` is `users`, and `.columns` is keyed by the folded name.

## The tags

| Tag | Statement | Entity type |
|---|---|---|
| `schema` | `CREATE SCHEMA` | `Postgres::Schema` |
| `table` | `CREATE TABLE` | `Postgres::Table` |
| `index` | `CREATE INDEX` | `Postgres::Index` |
| `view` | `CREATE VIEW`, `CREATE MATERIALIZED VIEW` | `Postgres::View`, `Postgres::MaterializedView` |
| `sequence` | `CREATE SEQUENCE` | `Postgres::Sequence` |
| `type` | `CREATE TYPE ... AS ENUM` | `Postgres::Enum` |
| `domain` | `CREATE DOMAIN` | `Postgres::Domain` |
| `extension` | `CREATE EXTENSION` | `Postgres::Extension` |

`table` and `view` imported from the package root are ClickHouse's. Import every tag from `@intentius/chant-lexicon-sql/postgres`.

## Interpolations

| Value | Means | Renders as |
|---|---|---|
| a Postgres entity | a reference to that object | its schema-qualified name; a schema renders as its name |
| `entity.columns.<name>` | a reference to one column | the column's name |
| a sequence inside `nextval(...)`, `currval(...)`, `setval(...)`, or any object before `::regclass` | a reference to the object | a `regclass` literal |
| a string | SQL text, spliced in before the statement is parsed | itself |
| a number, bigint, boolean or `null` | a literal | `42`, `true`, `NULL` |
| `literal(value)` | a string literal | `'quoted and escaped'` |

Reach columns through `.columns` and only there. `${users.kind}` is the entity's own field (the string `"resource"`) and `${users.id}` is `undefined`; SQLPG002 flags the first. In a join, qualify each reference: `u.${users.columns.id}`.

A plain string is SQL text. When a string is a value, wrap it in `literal()`: `DEFAULT ${literal(plan)}` writes `DEFAULT 'free'`, where `DEFAULT ${plan}` writes `DEFAULT free`, a reference to a column or function of that name. A single quote inside is doubled and a backslash is left alone, as `standard_conforming_strings` reads it.

## Tables and constraints

A table's props hold its columns (type, `NOT NULL`, default, generated and identity, collation, storage, comment) and every constraint kind: primary key, unique (including `NULLS NOT DISTINCT` and `INCLUDE`), check, foreign key, exclusion. Column constraints and table constraints are filed together. Name a constraint (`CONSTRAINT orders_amount_ck CHECK (...)`) when a later migration must refer to it, because a generated name is not stable.

```ts
export const orders = table`
  CREATE TABLE ${app}.orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES ${users} (${users.columns.id}) ON DELETE CASCADE,
    amount     numeric(12, 2) NOT NULL,
    placed_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT orders_amount_ck CHECK (amount >= 0)
  )`;
```

Partitioning (`PARTITION BY`, `PARTITION OF ... FOR VALUES`), `INHERITS`, `LIKE`, `OF type`, storage parameters and `USING` are parsed too. Each partition is its own `table` template that names its parent as an entity. A primary key or unique constraint on a partitioned table must include every partition key column.

## Indexes

An index needs a name, unqualified (it lives in its table's schema), because the name is its identity on the server. SQLPG001 reports an unnamed one.

```ts
import { index } from "@intentius/chant-lexicon-sql/postgres";

export const ordersUser = index`
  CREATE INDEX orders_user_id_idx ON ${orders} (${orders.columns.user_id}, ${orders.columns.placed_at} DESC)`;
```

The index records `CONCURRENTLY`, its method, each element (with the column when the element is one), `INCLUDE` and `WHERE`. An expression element such as `lower(${users.columns.email})` is recorded as an expression.

## Views

```ts
import { view } from "@intentius/chant-lexicon-sql/postgres";

export const orderTotals = view`
  CREATE VIEW ${app}.order_totals AS
  SELECT u.${users.columns.id} AS user_id, count(o.${orders.columns.id}) AS order_count
  FROM ${users} u
  LEFT JOIN ${orders} o ON o.${orders.columns.user_id} = u.${users.columns.id}
  GROUP BY u.${users.columns.id}`;
```

A view's lineage is recorded per output column of its top-level select list, from the column references in it. Write `${users.columns.id}` rather than bare `id` where you want that edge. A column named inside SQL text is not a reference. An unaliased item takes Postgres's own name (`count(x)` is `count`, `x::text` is `x`, anything else `?column?`), so alias what you want to name. A `CREATE MATERIALIZED VIEW` goes in a `view` template as well.

## Sequences

```ts
import { sequence } from "@intentius/chant-lexicon-sql/postgres";

export const invoiceSeq = sequence`CREATE SEQUENCE ${app}.invoice_seq AS bigint START WITH 1000`;

// in a table: invoice_no bigint NOT NULL DEFAULT nextval(${invoiceSeq})
```

`nextval(${invoiceSeq})` renders as `nextval('app.invoice_seq'::regclass)`, which is how the catalog prints the default, so the declaration and the live database read the same, and the table depends on the sequence. A name typed in a string (`nextval('app.invoice_seq')`) records no edge and the create order can put the table first; SQLPG003 warns about it. A sequence `OWNED BY` a column whose default calls `nextval` on that sequence is a reference cycle, and the build's cycle error names it. Use an identity column for that case.

## Enum and domain types, extensions

```ts
import { domain, extension, type } from "@intentius/chant-lexicon-sql/postgres";

export const status = type`CREATE TYPE ${app}.order_status AS ENUM ('placed', 'paid', 'cancelled')`;
export const email = domain`CREATE DOMAIN ${app}.email AS text CONSTRAINT email_shape CHECK (VALUE ~ '^[^@]+@')`;
export const citext = extension`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA ${app}`;
```

Use the entity as a column type: `status ${status} NOT NULL DEFAULT 'placed'`. The table then depends on the type. Enum labels are values of the type, so a label cannot be removed or reordered later without a rebuild; add labels at the end. An extension is an object of its own with no references to it from a column type, so a table using a type it provides does not wait for it; keep extensions in a project the database already has, or apply them first.

## Comments

Postgres has no inline comment clause. Follow the `CREATE` with `COMMENT ON` for the object, its columns and its named constraints, separated by `;`:

```ts
export const users = table`
  CREATE TABLE ${app}.users (id bigint PRIMARY KEY, email text NOT NULL);
  COMMENT ON TABLE ${app}.users IS 'One row per account';
  COMMENT ON COLUMN ${app}.users.email IS 'Unique; lower-cased by the app'`;
```

The comments fold into the entity's `comment`, each column's and each constraint's, and stay in the DDL. A template that starts with `COMMENT ON` is refused.

## What the build records

References become dependency edges: a table after its schema, its enum and domain types, its sequences and the tables it references; an index after its table; a view after what it reads. The build lists objects in that order as `applyOrder` and writes every statement, in that order, to `postgres.sql` next to the JSON document. A reference cycle is an error naming the cycle (a pair of tables that reference each other needs one foreign key added after both exist, which is a migration, not a declaration).

## Checks

| Id | Severity | What it flags |
|---|---|---|
| SQLPG001 | error | the DDL does not parse, the template holds another statement than its tag or a second `CREATE`, or an index has no name |
| SQLPG002 | error | `${users.kind}` where `${users.columns.kind}` was meant |
| SQLPG003 | warning | an object named in a regclass string instead of interpolated |

SQLPG001 is reported at the token, as a line and column of the `.ts` file, by `chant lint` and in the editor. An error inside text a string interpolation supplies is left to the build.

## Commands

```bash
chant lint src
chant build src --lexicon sql -o dist/schema.json
```

`chant init --lexicon sql --template postgres` scaffolds a default app schema: a schema, two tables with a foreign key, an index and a view. `--template postgres-tenant` adds a multi-tenant schema whose keys and indexes lead with the tenant column, and `--template postgres-events` an events table partitioned by month.

## Not covered

`ALTER`, `CREATE POLICY`, `GRANT`, functions, triggers, rules and the composite and range forms of `CREATE TYPE` are not declared with the tags. Plan-and-apply (lock classes, transactions, timeouts) and the expand-and-contract migration Op have their own skills, which arrive with the code they describe.
