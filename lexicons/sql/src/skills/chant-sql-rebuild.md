---
skill: chant-sql-rebuild
description: Run a ClickHouse table rebuild (a sorting key, primary key, partition key, engine or key column type change) with ClickHouseRebuildOp, a gated Op with backfill receipts, verification, an exchange swap and onFailure cleanup
user-invocable: true
---
# Running a ClickHouse rebuild migration

Use this skill when `chant sql plan` or `chant sql diff` exits 2 because a table's change is a rebuild: a sorting key rename or reorder (SQLCH220), a primary key change (SQLCH221), a partition key change (SQLCH222), an engine or engine argument change such as a ReplacingMergeTree version column (SQLCH223), or a key column's type (SQLCH211). ClickHouse has no ALTER for these. The data is copied into a new table, and the old one is swapped out.

`ClickHouseRebuildOp` rebuilds tables. A view's or materialized view's rebuild-class change (SQLCH224, SQLCH242, SQLCH243) is a drop and a create of that view, not this Op.

## Declare the Op

The plan names the Op for each refused table, with the table filled in and a dual-write mode suggested. Copy it into an `*.op.ts` file in the same pull request as the schema change:

```typescript
// ops/rebuild-events.op.ts
import { ClickHouseRebuildOp } from "@intentius/chant-lexicon-sql/clickhouse";

export const { op } = ClickHouseRebuildOp({
  name: "rebuild-shop-events",
  env: "prod",                       // sql.profiles.prod
  table: "shop.events",              // database.name on the server
  dualWrite: { mode: "materialized-view", cutoverColumn: "ts" },
  retain: "7d",                      // how long the old table is kept
});
```

Options: `name`, `env`, `table`, `dualWrite` (required); `output` (default `dist/schema.json`), `path`, `build` (default true runs `chant build` first), `retain` (default `7d`), `gate` (the swap gate: `gate`, `timeout`, `description`, `approval`), `dropGate`, `writesGate` (app mode), `backfillTimeout` (default `6h`), `mutationTimeout` (default `10m`), `stack`, `ownershipEnv`.

Pick the dual-write mode:

- `{ mode: "materialized-view", cutoverColumn: "ts", cutoverDelay?: "1m" }` when the table has a time column rows arrive in order of. Writes keep flowing: a materialized view sends rows at or after the cut-over to the new table, the backfill copies the rows before it.
- `{ mode: "app" }` otherwise. A gate, `<name>-writes-stopped`, waits for someone to confirm the application stopped writing to the table; writes resume after the swap.

## Run it

```bash
chant run rebuild-shop-events        # new table, dual write, backfill, verify; exits 3 at approve-rebuild-shop-events
chant run status rebuild-shop-events # the Verification, VerifiedPartitions and VerifiedRows outcomes
chant approve rebuild-shop-events approve-rebuild-shop-events --actor <you>
chant run rebuild-shop-events        # swaps, recreates the views that read the table; exits 3 at approve-rebuild-shop-events-drop
chant approve rebuild-shop-events approve-rebuild-shop-events-drop --actor <you>
chant run rebuild-shop-events        # drops the old table once retain has passed
```

Each run goes as far as the next gate. Every step reads the server again, so re-running after a gate, a crash or an approval carries on where the last run stopped.

The swap gate is bound to a digest of the plan and the verification (row counts and checksums per partition). If the next run verifies different numbers, the gate asks again. The drop gate is bound to the old table's UUID and retention date; approving it early is fine, nothing is dropped before the date.

## When something goes wrong

- A run stopped during the backfill (Ctrl-C, a killed job) is not a failure. The next run resumes from the receipts in `chant_receipts.receipts` on the same server, and a partition whose copy was cut off before its receipt is cleared and copied again, so no row is copied twice.
- A failed step (a failed copy after its retries, a verification mismatch, a refused declaration) runs onFailure: the new table `<t>__chant_new` and the dual-write view `<t>__chant_dual` are dropped, and the next run starts from a new table. The original table is untouched until the swap.
- A verification mismatch in materialized-view mode usually means rows arrived with a time before the cut-over later than `cutoverDelay`. Raise the delay and run again.
- The Op refuses a database that is not Atomic (`EXCHANGE TABLES` needs it), a table whose change is not a rebuild (use the applier), and an object already under one of its working names that is not its own.

## Checking it is done

`chant sql plan <env> dist/schema.json` reports no changes for the table, `<t>__chant_old` is gone after the drop, and a later `chant run` of the Op reports `RebuildState` `done`. Then remove the `*.op.ts` file.

The rebuild's working tables carry chant's comment marker with `rebuild=<db.t>` and a role, and plans, imports and prunes leave them out, so an `ApplyOp` for the rest of the schema can run beside a rebuild.
