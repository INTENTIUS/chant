/**
 * Symptom derivation (#1484, epic #1487 feature 5) — one typed record joining
 * the status join (./status.ts), change-set summaries (./change-set.ts), and
 * unobserved evidence (../observation.ts) into the shape `ConvergeOp`'s rule
 * table evaluates against.
 *
 * Derive-only, per the issue's leaning on its own open question 4: no new
 * `LexiconPlugin.symptoms?()` interface in v1 — everything here is a pure
 * projection of structures chant already computes (`ChangeSet`,
 * `ComponentStatusRow[]`). No I/O in this module; a caller (the `convergeTick`
 * activity, lexicons/temporal/src/op/activities/converge.ts) gathers those
 * inputs and hands them here.
 *
 * One record per tick, not per component: the issue's own rule sketch reads
 * `s.status`/`s.backupVerifiedAge` as a single symptom `s` a rule closes
 * over, and epic feature 5 calls it "one typed record" (singular). A
 * multi-component environment still resolves to one record per tick —
 * `components` carries the per-component detail behind the aggregate for
 * reporting, and `status` is the worst verdict across all of them (see
 * {@link worstStatus}), so "any component is unknown" is enough to trip
 * `unknown never remediates` for the whole tick.
 */
import type { ChangeAction, ChangeSet } from "./change-set";
import { summarize } from "./change-set";
import type { ComponentStatusRow } from "./status";
import { unobservedReasonText, type UnobservedReason } from "../observation";

/**
 * Verdict priority, most-cautious first: if anything is `unknown`, the tick
 * as a whole must be treated as `unknown` — "unknown never remediates" is a
 * whole-tick property, not a per-component one, since a rule table has no
 * way to act on "some of the environment" only. `drifted` outranks `stale`/
 * `unrecorded` because it is the actionable case ApplyOp's re-apply fixes;
 * `reconciled` is the quiet-environment default.
 */
const STATUS_PRIORITY: readonly ComponentStatusRow["reconciliation"][] = [
  "unknown",
  "drifted",
  "stale",
  "unrecorded",
  "reconciled",
];

/** The worst (most-cautious) reconciliation verdict across a set of component rows. `"reconciled"` for an empty set — nothing to converge is a quiet environment. */
export function worstStatus(rows: ComponentStatusRow[]): ComponentStatusRow["reconciliation"] {
  const present = new Set(rows.map((r) => r.reconciliation));
  for (const candidate of STATUS_PRIORITY) {
    if (present.has(candidate)) return candidate;
  }
  return "reconciled";
}

/**
 * One tick's typed symptom record. Every field a `ConvergeOp` rule may
 * reference — see `../op/converge-rule.ts`'s `SymptomPredicate<S>`, where
 * `S` is this interface, so a rule whose predicate names a field outside
 * this shape fails TypeScript at the author's call site (the "symptom field
 * nothing produces" build-time refusal).
 */
export interface ConvergeSymptom {
  env: string;
  /** The worst reconciliation verdict across every component row this tick observed (see {@link worstStatus}). */
  status: ComponentStatusRow["reconciliation"];
  /** Per-component detail behind `status`, for reporting — never read by a rule predicate directly (rules read the flat counts below). */
  components: ComponentStatusRow[];
  /** Change-set action counts for the tick (./change-set.ts's `summarize`). */
  createCount: number;
  updateCount: number;
  deleteCount: number;
  /** Live but undeclared, ownership unestablished — a candidate to adopt into source. Never auto-claimed; see the issue's "adopt is reported, never auto-claimed" honesty requirement. */
  adoptCount: number;
  runtimeCount: number;
  effectCount: number;
  /** Declared, but the lexicon could not observe it (#1089) — the count backing `status: "unknown"`. */
  unobservedCount: number;
  /** Every distinct reason behind `unobservedCount`, for a report action's detail. */
  unobservedReasons: UnobservedReason[];
  /** Total resource count under change-set evidence for this tick (sum of the six counts above). */
  totalCount: number;
}

/**
 * Join a `ChangeSet` and `ComponentStatusRow[]` for one tick into a
 * `ConvergeSymptom`. Pure — no I/O.
 */
export function deriveSymptoms(env: string, cs: ChangeSet, statusRows: ComponentStatusRow[]): ConvergeSymptom {
  const counts: Record<ChangeAction, number> = summarize(cs);
  const unobservedReasons = [
    ...new Set(
      cs.entries
        .filter((e): e is typeof e & { unobservedReason: UnobservedReason } => e.action === "unobserved" && e.unobservedReason !== undefined)
        .map((e) => e.unobservedReason),
    ),
  ].sort((a, b) => unobservedReasonText(a).localeCompare(unobservedReasonText(b)));

  return {
    env,
    status: worstStatus(statusRows),
    components: statusRows,
    createCount: counts.create,
    updateCount: counts.update,
    deleteCount: counts.delete,
    adoptCount: counts.adopt,
    runtimeCount: counts.runtime,
    effectCount: counts.effect,
    unobservedCount: counts.unobserved,
    unobservedReasons,
    totalCount: cs.entries.length,
  };
}

/** Every field name a `ConvergeSymptom` produces — the runtime whitelist `TMP014` (lexicons/temporal) re-validates a serialized rule table's predicates against. Kept in sync with {@link ConvergeSymptom} by hand (deliberately small, changes rarely). */
export const CONVERGE_SYMPTOM_FIELDS: ReadonlySet<string> = new Set([
  "env",
  "status",
  "components",
  "createCount",
  "updateCount",
  "deleteCount",
  "adoptCount",
  "runtimeCount",
  "effectCount",
  "unobservedCount",
  "unobservedReasons",
  "totalCount",
]);
