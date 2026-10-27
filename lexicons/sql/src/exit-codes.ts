/**
 * SQL engine outcomes mapped onto chant's exit-code table (#4553, `CHANT_EXIT`
 * in `@intentius/chant/exit-codes`), for the versioned migration engine chant
 * runs through the sql capability (sql-yodeler, `yodel`).
 *
 * sql-yodeler from sql-yodeler#288 on exits by chant's table, so its codes
 * pass through. An older yodel has its own table, where 3 means anything
 * outstanding (lint errors included) and 4 every refusal; {@link yodelExitOf}
 * reads one of those with the command it came from.
 *
 * | Engine outcome | Table |
 * |---|---|
 * | applied, nothing pending, stood down at plan time | `done` |
 * | a wave plan that moved (`WavePlanMoved`), an approval of another digest | `moved` |
 * | a policy rule denies the plan and no override counts | `denied` |
 * | another apply holds the history lock | `held` |
 * | a newer commit on the branch applies the same environment (stand-down) | `superseded` |
 * | an apply stopped at its gate, pending migrations under `yodel status`, a migration the required environment has not applied, a change that needs an Op the engine does not run, a manual step | `waiting` |
 * | drift found by `yodel drift` | `drift` |
 * | a checksum mismatch, a fork, an out-of-order migration, an applied migration gone from the directory, reader and writer one identity, a write run with the reader, lint errors | `failed` |
 */
import { CHANT_EXIT, type ChantExitCode } from "@intentius/chant/exit-codes";

/** An outcome of the versioned migration engine, by name. */
export type SqlEngineOutcome =
  | "applied"
  | "unchanged"
  | "plan-moved"
  | "approval-moved"
  | "policy-denied"
  | "lock-held"
  | "stood-down"
  | "gated"
  | "pending"
  | "promotion-unmet"
  | "needs-op"
  | "manual-step"
  | "drift"
  | "checksum-mismatch"
  | "fork"
  | "out-of-order"
  | "directory"
  | "shared-identity"
  | "reader-write"
  | "lint-errors"
  | "failed";

const OUTCOME_EXIT: Record<SqlEngineOutcome, ChantExitCode> = {
  applied: CHANT_EXIT.done,
  unchanged: CHANT_EXIT.done,
  "plan-moved": CHANT_EXIT.moved,
  "approval-moved": CHANT_EXIT.moved,
  "policy-denied": CHANT_EXIT.denied,
  "lock-held": CHANT_EXIT.held,
  "stood-down": CHANT_EXIT.superseded,
  gated: CHANT_EXIT.waiting,
  pending: CHANT_EXIT.waiting,
  "promotion-unmet": CHANT_EXIT.waiting,
  "needs-op": CHANT_EXIT.waiting,
  "manual-step": CHANT_EXIT.waiting,
  drift: CHANT_EXIT.drift,
  "checksum-mismatch": CHANT_EXIT.failed,
  fork: CHANT_EXIT.failed,
  "out-of-order": CHANT_EXIT.failed,
  directory: CHANT_EXIT.failed,
  "shared-identity": CHANT_EXIT.failed,
  "reader-write": CHANT_EXIT.failed,
  "lint-errors": CHANT_EXIT.failed,
  failed: CHANT_EXIT.failed,
};

/**
 * The table's code for an engine outcome. A refusal no approval fixes is
 * `failed`; one a person can clear (a gate, an unmet promotion) is `waiting`.
 */
export function sqlExitOf(outcome: SqlEngineOutcome): ChantExitCode {
  return OUTCOME_EXIT[outcome];
}

/** Whether `outcome` is a plan that moved since its approval. */
export function sqlPlanMoved(outcome: SqlEngineOutcome): boolean {
  return sqlExitOf(outcome) === CHANT_EXIT.moved;
}

/** yodel's own exit table before sql-yodeler#288 (its `src/exit.ts` up to 0.10). */
export const YODEL_LEGACY_EXIT = {
  ok: 0,
  error: 1,
  /** Something yodel will not do itself; drift, for `yodel drift`. */
  needsOp: 2,
  /** Something outstanding: a gate, pending migrations, lint errors. */
  outstanding: 3,
  /** Refused, nothing done: every refusal, policy denials and unmet promotions included. */
  refused: 4,
  locked: 5,
} as const;

/** A `yodel` exit status and the command it came from. */
export interface YodelExitSource {
  code: number | null | undefined;
  /** The yodel verb (`apply`, `status`, `lint`, `drift`, ...). */
  command?: string;
  /** The yodel predates sql-yodeler#288 and exits by {@link YODEL_LEGACY_EXIT}. */
  legacy?: boolean;
}

/**
 * The table's code for a `yodel` exit status. A yodel on chant's table passes
 * through (a code outside the table is `failed`). A legacy yodel's codes are
 * read by meaning:
 *
 * | legacy yodel | Table |
 * |---|---|
 * | 0 | `done` |
 * | 2 from `yodel drift` | `drift` |
 * | 2 from any other verb, a change that needs an Op or a manual step | `waiting` |
 * | 3 from `yodel lint` | `failed` (sql-yodeler#285 ruling C) |
 * | 3 from any other verb | `waiting` |
 * | 4, any refusal | `failed`: the legacy code does not tell a policy denial or an unmet promotion apart |
 * | 5 | `held` |
 * | 1, anything else | `failed` |
 */
export function yodelExitOf(source: YodelExitSource): ChantExitCode {
  const { code, command, legacy } = source;
  if (code === 0) return CHANT_EXIT.done;
  if (!legacy) {
    for (const value of Object.values(CHANT_EXIT)) if (value === code) return value;
    return CHANT_EXIT.failed;
  }
  switch (code) {
    case YODEL_LEGACY_EXIT.needsOp:
      return command === "drift" ? CHANT_EXIT.drift : CHANT_EXIT.waiting;
    case YODEL_LEGACY_EXIT.outstanding:
      return command === "lint" ? CHANT_EXIT.failed : CHANT_EXIT.waiting;
    case YODEL_LEGACY_EXIT.locked:
      return CHANT_EXIT.held;
    default:
      return CHANT_EXIT.failed;
  }
}
