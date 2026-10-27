/**
 * The lock grain of a SQL member (#4571, on #4552's hooks).
 *
 * A SQL member's grain is `target`: one environment's history. Two applies
 * of one environment are kept apart by the environment's own lock, which
 * sql-yodeler takes for every apply (a KeeperMap row on ClickHouse, a
 * session advisory lock on Postgres), and by chant's target lock on the
 * environment. `sql-apply` sends a whole build in creation order, so it
 * holds the environment too.
 *
 * `resource` is refused by name, as it is on Terraform and stock Pulumi: a
 * migration chain applies in order, and a row per object would let two
 * applies of one chain interleave. Neither kind answers `lockRows`. `repo`
 * is the pipeline's, and any member may take it.
 *
 * sql-yodeler's rendered apply jobs set `APPLY_LOCK` (`YODEL_LOCK_WAIT`,
 * `YODEL_STAND_DOWN`, src/ci/render.ts:323) for the engine's lock wait and
 * its stand-down; dropping it for these hooks is sql-yodeler#293's.
 */
import type { LockGrain } from "@intentius/chant/lifecycle/lock-rows";

/** The capability kinds this lexicon gives a grain to. */
export type SqlLockGrainKind = "sql-migrate" | "sql-apply";

/** The grain a SQL member takes when `ci.lockGrain` sets none: always `target`. */
export function sqlDefaultLockGrain(): LockGrain {
  return "target";
}

/** Why a SQL member cannot take `grain`, naming the engine; undefined for `target` and `repo`. */
export function sqlLockGrainRefusal(kind: SqlLockGrainKind, grain: LockGrain): string | undefined {
  if (grain !== "resource") return undefined;
  if (kind === "sql-migrate") {
    return "SQL Yodeler applies an environment's migrations in chain order under the environment's own lock (a KeeperMap row on ClickHouse, a session advisory lock on Postgres), so nothing in it is per resource (ci.lockGrain: target)";
  }
  return "the sql lexicon's applier sends a whole build in creation order, since its objects depend on each other, so nothing in it is per resource (ci.lockGrain: target)";
}
