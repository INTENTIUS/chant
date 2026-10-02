---
skill: chant-sql-rebuild
description: Run a ClickHouse rebuild migration (a sorting key, partition key or engine change) as a gated Op with backfill receipts, verification, an exchange swap and onFailure cleanup; depends on the rebuild Op in #3198
user-invocable: true
---
# Running a ClickHouse rebuild migration

Use this skill when `chant sql plan` or `chant sql diff` exits 2 because a change is a rebuild: a sorting key rename or reorder (SQLCH220), a primary key change (SQLCH221), a partition key change (SQLCH222), an engine or engine argument change such as a ReplacingMergeTree version column (SQLCH223), or a materialized view's `TO` target (SQLCH242). ClickHouse has no ALTER for these. The data is copied into a new table, and the old one is swapped out.

## Dependency on #3198

The rebuild Op is issue #3198 ("the ClickHouse rebuild migration as a gated composite Op"). It is not built when this skill is written. Everything below under "The Op" is what #3198's issue body commits to, not shipped behavior. Names of the composite and its options are not final, so this skill shows none: read the sql docs page "The rebuild migration Op" and the lexicon's exports once #3198 has merged, and correct anything here that differs. Four decisions are still open in that issue and are listed at the end.

## The phases

| Phase | Step |
|---|---|
| Create | the new table |
| Dual write | a materialized view from old to new, or an application switch behind a gate |
| Backfill | `INSERT ... SELECT` per partition, each in an `effect()` with a receipt |
| Verify | row counts and checksums per partition |
| Gate | approval bound to the plan digest, with the verification in its context |
| Swap | `EXCHANGE TABLES`, then recreate the materialized views that read the table |
| Retain | the old table for N days, then a gated drop |
| `onFailure` | drop the new table |

What this gives you:

- The gate comes after verification and before the swap. The person approving sees the per-partition counts and checksums, and the approval is bound to the plan digest, so a plan that changed after it was reviewed does not run under the old approval.
- Backfill is one `effect()` per partition. A receipt is written last, only when the partition's copy succeeded, so a run interrupted halfway resumes from its receipts and does not copy a partition twice.
- The old table is kept for a retention period and dropped only behind a second gate.
- A failed run triggers `onFailure`, which drops the new table. The old table has not been touched at that point, because the swap is the step after the gate.

## Running it

An Op is run with `chant run <name>`, in process, or on a steward with `--on fountain`. A gate stops the run and is resolved with `chant approve <gate-name>`. The record of a run, including receipts, is what `chant run` resumes from; the MCP tools `op-run`, `op-status` and `op-signal` start and watch it programmatically.

Typical order for a sorting key change in a pull request:

```bash
chant build src --lexicon sql -o head.json
chant sql diff base.json head.json     # exits 2, names SQLCH220 and the table
```

then hand the classified rebuild to the Op (how the plan passes it on is one of the open decisions below), watch it reach the gate, read the verification, approve, and let it swap.

Using the Op from your own `*.op.ts` file follows the shape in the Ops guide: `Op({ name, phases })`, `phase(...)`, `gate(...)`, and `effect(receipt, steps)` for the backfill. Do not hand-write the swap with `shell` unless #3198 has not merged and you accept the risk: the receipts and the gate binding are the point.

## Constraints to check before starting

- `EXCHANGE TABLES` needs both tables in a database on the Atomic engine. A database on another engine is one of the open decisions; check the database's engine first.
- Background rewrites must finish before the swap. How a run waits on them (through `system.mutations`) is an open decision.
- During the dual-write phase, inserts reach both tables. A materialized view from old to new does this for you; an application switch needs the application's cooperation and sits behind a gate.
- Materialized views that read the old table are recreated after the swap. Their `TO` targets are fixed at creation, so recreating them is the step, not altering them.

## Open decisions in #3198

1. Where backfill receipts live: git, or a table in ClickHouse.
2. What to do when the database is not on the Atomic engine.
3. How a run waits on background rewrites through `system.mutations`.
4. How the plan hands a classified rebuild to the Op.

When one of these is settled on the issue, update this skill to say which way it went.

## Done means

A sort-key change in a pull request plans as this Op, stops at its gate with verification attached, swaps, and recreates the materialized views that read the table. `chant sql plan` against the server then reports no changes.
