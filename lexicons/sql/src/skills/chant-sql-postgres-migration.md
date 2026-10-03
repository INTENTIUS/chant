---
skill: chant-sql-postgres-migration
description: Run a Postgres column rename or type change with PostgresMigrationOp, a gated expand-and-contract Op with a dual-write trigger, a batched backfill with receipts, verification, a switch, replication lag handling and onFailure cleanup
user-invocable: true
---
# Running a Postgres column migration

Use this skill when `chant sql plan` or `chant sql diff` exits 2 because a column's change is a rename (SQLPG205) or a type change across kinds (SQLPG208, text to integer). Postgres has no way to make these in place without breaking readers or failing on existing rows, and the applier refuses them. `PostgresMigrationOp` makes them as expand and contract: a new column is added beside the old, kept written, filled in batches, verified, and swapped in behind an approval.

A type change within a kind that rewrites the table under `ACCESS EXCLUSIVE` (SQLPG207, integer to bigint) can run as the same Op: it fills the new column in batches instead of holding the lock for a rewrite. The plan does not hand that one over; write the declaration yourself. The other expand-and-contract rules (a NOT NULL column with no default, partitioning, an object rename, a view's columns, enum labels) have no Op.

## Declare the Op

The plan prints a declaration for each refused column, and `--json` carries them as `migrationOps`. Copy it into an `*.op.ts` file in the same pull request as the schema change:

```typescript
// ops/migrate-app-users-login.op.ts
import { PostgresMigrationOp } from "@intentius/chant-lexicon-sql/postgres";

export const { op } = PostgresMigrationOp({
  name: "migrate-app-users-login",
  env: "prod",                // sql.profiles.prod
  table: "app.users",         // schema.name as the server knows it
  column: "login",            // the column as the build declares it: the new name for a rename
});
```

For a type change, `using` is the expression that computes the new value from the old row, as `ALTER COLUMN ... TYPE ... USING` takes it. It defaults to a cast to the declared type; set it when the cast is not the conversion you want:

```typescript
PostgresMigrationOp({ name: "migrate-orders-amount", env: "prod", table: "shop.orders", column: "amount", using: "NULLIF(amount, 'n/a')::numeric(12,2)" });
```

Options besides `name`, `env`, `table`, `column`, `using`:

- `batchSize` (default 1000): the width of one key range;
- `retain` (default `7d`): how long the old column is kept after the switch;
- `replicationLag` (default `{ max: "10s", wait: "30m" }`, or `false`): see below;
- `lockTimeoutMs` (default the profile's, else 5000) and `statementTimeoutMs` (default the profile's, else 60000, not applied to the scans of validation and verification);
- `gate` and `contractGate`: the two approvals, each with `gate` (name), `timeout` and `description`; `gate` also takes `approval` for quorum, roles and a policy, and a policy gets `verifiedRows` and `mismatched` as context;
- `backfillTimeout` (default `6h`), `output` (default `dist/schema.json`), `path`, `build` (default true runs `chant build` first), `stack`, `ownershipEnv`.

## What it does

| Phase | Step |
|---|---|
| Build | `chant build` |
| Plan | classifies the column's change against the server and refuses what the Op does not make |
| Expand | adds the new column, nullable, no default (a catalog change) |
| Dual write | a trigger keeps the new column written: computed from the old one for a type change, both ways for a rename |
| Backfill | `UPDATE` per primary-key range, each batch in its own transaction with its receipt, under `lock_timeout` |
| Verify | compares rows, mismatches, NULLs and checksums of the new column against the old |
| Approve | the switch gate |
| Switch | proves a declared NOT NULL with a `NOT VALID` check then `VALIDATE`; then one short transaction: a type change swaps the columns by name, a rename finishes the new column and keeps both written |
| Retain | keeps the old column until `retain` has passed |
| Approve contract | the contract gate |
| Contract | drops the old column, and a rename's trigger |

## Run it

```bash
chant run migrate-app-users-login        # expand, dual write, backfill, verify; exits 3 at approve-migrate-app-users-login
chant run status migrate-app-users-login # Filled, Skipped, BackfilledRows, Verification, VerifiedRows
chant approve migrate-app-users-login approve-migrate-app-users-login --actor <you>
chant run migrate-app-users-login        # switches; exits 3 at approve-migrate-app-users-login-contract
chant approve migrate-app-users-login approve-migrate-app-users-login-contract --actor <you>
chant run migrate-app-users-login        # drops the old column once retain has passed
```

Each run goes as far as the next gate. Every step reads the server again, so a run after a gate, a crash or an approval carries on where the last stopped.

The switch gate is bound to a digest of the plan and the verified new column. If the next run verifies different numbers, the gate asks again. For a rename, readers move to the new name at the switch, and the old name keeps working for writers until the contract, so deploy readers before approving. The contract gate is bound to the old column's identity and retention date; approving it early is fine, nothing is dropped before the date.

## Receipts and resuming

Each batch commits its `UPDATE` and its receipt in one transaction, in `<schema>.__chant_receipts` in the migrated table's schema. A run killed during the backfill (Ctrl-C, a lost machine) is not a failure and runs no onFailure. The next run skips the batches that have receipts and fills the rest, so no batch is updated twice. The receipts bind the table's oid and the new column, so receipts from another table or an earlier attempt are not reused.

## Replication lag

Before each batch the backfill reads `pg_stat_replication` and pauses while a replica's replay lag is above `replicationLag.max`, for up to `wait` at a time. With no replicas it carries on. If `wait` passes with a replica still behind, the backfill stops with a message naming the replica, keeps its receipts, and the next run goes on from there.

A role that is neither superuser nor a member of `pg_monitor` cannot read other sessions' lag, and the backfill stops saying so rather than guess. Grant it and run again:

```sql
GRANT pg_monitor TO migration_role;
```

or set `replicationLag: false` to run without the check.

## When something goes wrong

- A failed step (a value the `using` expression cannot convert, a verification mismatch, a refused declaration) runs onFailure: the trigger, its function, the check, the new column and the receipts table are dropped, and the plan shows the original change again. The old column was never touched. Fix the declaration or the data and run again. A failed gate or an aborted run does not run onFailure.
- A lock timeout means another session holds a lock the step needs (SQLSTATE 55P03). The step retries a few times, then fails. Run again when the blocker has finished.
- The working objects (new column, trigger, function, check, receipts table) carry chant's comment marker with a `migration=` key, and plans, imports and prunes leave them out, so an `ApplyOp` for the rest of the schema can run beside a migration. An object under one of the working names that is not this migration's stops the run; rename or drop it by hand.

## What the Op refuses today

The Plan phase refuses, naming what is in the way, a table or column with:

- an index, constraint (a foreign key from another table included) or view over the column;
- a primary key that is not one smallint, integer or bigint column;
- a rename combined with a type change, or a rename of a column with a default;
- a column a logical replication publication sends (a column list that leaves it out does not stop the Op);
- a generated or identity column, or a partitioned or inheriting table;
- a column that needs no migration, where the message says to use the applier.

Chant #3322 extends these: indexed columns, other batch keys, renames with defaults, and published tables. Until it lands, drop the index or constraint, migrate, then declare it again on the new column, or make the change by hand.

## Checking it is done

`chant sql plan <env> dist/schema.json` reports no changes for the column, the old column and the receipts table are gone, and a later `chant run` of the Op reports done. Then remove the `*.op.ts` file.
