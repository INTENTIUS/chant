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
 * activity, ../op/activities/converge.ts) gathers those inputs and hands them
 * here.
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

/** Every field name a `ConvergeSymptom` produces — the runtime whitelist `OPS014` (packages/core/src/lint/rules/op/ops014-converge-rule-refusals.ts) re-validates a serialized rule table's predicates against. Kept in sync with {@link ConvergeSymptom} by hand (deliberately small, changes rarely). */
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

// ── Resources an observer step reports (#2778) ──────────────────────────────

/**
 * One resource's verdict, as an observer step reports it: `in-sync` when it
 * is what its declaration says, `drifted` when it isn't, and `unknown` when
 * the observer could not tell.
 */
export type ResourceStatus = "in-sync" | "drifted" | "unknown";

/** One resource an observer step looked at. */
export interface ObservedResource {
  name: string;
  status: ResourceStatus;
  /** Why the observer gave that verdict, in one line. */
  detail?: string;
}

/**
 * What a `ConvergeOp`'s observer step returns (#2778), for resources no
 * lexicon declares or observes: the processes a supervisor runs in a box,
 * for example. `ConvergeOp({ observe })` evaluates its rules once per
 * resource, against a {@link ResourceSymptom}.
 */
export interface ResourceObservation {
  resources: ObservedResource[];
}

/**
 * The record a `ConvergeOp` with an observer step evaluates each rule
 * against, once per observed resource (#2778). A rule reads `status` (and
 * may read `resource` to single one out); a `run()` it fires is dispatched
 * for that resource, which the dispatched Op reads from
 * `CHANT_CONVERGE_RESOURCE`.
 */
export interface ResourceSymptom {
  env: string;
  /** The resource's name, as the observer reported it. */
  resource: string;
  status: ResourceStatus;
  /** The observer's one-line reason, or "". */
  detail: string;
}

/**
 * The environment variable a dispatched Op reads the resource from, when a
 * ConvergeOp with an observer step fired its rule for one resource (#2778).
 */
export const CONVERGE_RESOURCE_ENV = "CHANT_CONVERGE_RESOURCE";

/** Every field a {@link ResourceSymptom} produces: OPS014's whitelist for a ConvergeOp with an observer step. */
export const RESOURCE_SYMPTOM_FIELDS: ReadonlySet<string> = new Set(["env", "resource", "status", "detail"]);

const RESOURCE_STATUSES: ReadonlySet<string> = new Set(["in-sync", "drifted", "unknown"]);

/**
 * Read an observer step's result as a {@link ResourceObservation}. The
 * result is the observation itself, or a `shell()` step's result whose
 * stdout is the observation as JSON. Throws, naming what is wrong, on
 * anything else: a tick must not converge from a reading it can't parse.
 */
export function parseResourceObservation(value: unknown): ResourceObservation {
  let candidate: unknown = value;
  if (candidate && typeof candidate === "object" && !("resources" in candidate) && typeof (candidate as { stdout?: unknown }).stdout === "string") {
    const stdout = (candidate as { stdout: string }).stdout;
    try {
      candidate = JSON.parse(stdout);
    } catch {
      throw new Error(`the observer step's stdout is not JSON: ${stdout.slice(0, 120)}`);
    }
  }
  const resources = (candidate as { resources?: unknown } | null)?.resources;
  if (!Array.isArray(resources)) {
    throw new Error("the observer step returned no `resources` array: it must return { resources: [{ name, status }] }, or print it as JSON");
  }
  const seen = new Set<string>();
  const out: ObservedResource[] = [];
  for (const [i, r] of resources.entries()) {
    const entry = r as { name?: unknown; status?: unknown; detail?: unknown } | null;
    if (!entry || typeof entry.name !== "string" || entry.name === "") {
      throw new Error(`the observer step's resources[${i}] has no name`);
    }
    if (typeof entry.status !== "string" || !RESOURCE_STATUSES.has(entry.status)) {
      throw new Error(`the observer step's resource "${entry.name}" has status ${JSON.stringify(entry.status)}: it must be in-sync, drifted or unknown`);
    }
    if (seen.has(entry.name)) throw new Error(`the observer step reported resource "${entry.name}" twice`);
    seen.add(entry.name);
    out.push({
      name: entry.name,
      status: entry.status as ResourceStatus,
      ...(typeof entry.detail === "string" && entry.detail !== "" ? { detail: entry.detail } : {}),
    });
  }
  return { resources: out };
}
