/**
 * Converge rules (#1484) — the typed, JSON-serializable predicate language a
 * `ConvergeOp` rule table is built from.
 *
 * The issue's illustrative sketch writes a rule's condition as a JS arrow
 * function (`s => s.status === "drifted"`). That reads well but can't
 * actually ship: a rule is evaluated per-tick against live, freshly-observed
 * data inside a Temporal activity, and an activity's arguments — including
 * whatever a `ConvergeOp` composite bakes into its generated workflow — must
 * be plain JSON (see `step-output-ref.ts`'s module doc on why a value
 * crossing the workflow/activity boundary can't carry a closure). A rule
 * "outside the evaluable subset" is one of the build-time refusals #1484
 * names explicitly, which only makes sense if there IS an evaluable subset
 * to be outside of — so rules here are data: a small comparison language
 * over one typed symptom record, interpreted by {@link evaluatePredicate}
 * (pure, no I/O, matching Accessible Ops factor I — "predictable from the
 * text alone").
 *
 * `S` is the symptom record type a `ConvergeOp` instance evaluates against
 * (`ConvergeSymptom`, ../lifecycle/symptoms.ts, for the real thing — kept
 * generic here so the predicate language and its tests don't depend on the
 * lifecycle package). Since a predicate's `field` is typed `keyof S`, a rule
 * that names a field the symptom record doesn't have is refused by
 * TypeScript itself at the author's call site — the "symptom field nothing
 * produces" refusal, satisfied for free. {@link isWellFormedPredicate} is the
 * runtime backstop for a rule assembled by hand (bypassing `when()`/the
 * comparison builders) rather than authored through them, and is what a
 * build-time check (TMP014) re-validates the serialized rule table against.
 */

// ── Predicates ───────────────────────────────────────────────────────────────

/** Comparison operators over a single symptom field. */
export type FieldComparisonOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

/** Truthiness operators over a single symptom field — no `value` needed. */
export type FieldTruthinessOp = "truthy" | "falsy";

export interface FieldComparisonPredicate<S> {
  kind: "field-comparison";
  field: keyof S & string;
  op: FieldComparisonOp;
  value: string | number | boolean;
}

export interface FieldTruthinessPredicate<S> {
  kind: "field-truthiness";
  field: keyof S & string;
  op: FieldTruthinessOp;
}

export interface AllOfPredicate<S> {
  kind: "all-of";
  predicates: SymptomPredicate<S>[];
}

export interface AnyOfPredicate<S> {
  kind: "any-of";
  predicates: SymptomPredicate<S>[];
}

/**
 * A rule's `when` — the evaluable subset #1484 requires: field comparisons
 * and truthiness checks over `S`, composed with `allOf`/`anyOf`. Every
 * variant is plain JSON; there is deliberately no escape hatch to an
 * arbitrary expression.
 */
export type SymptomPredicate<S> =
  | FieldComparisonPredicate<S>
  | FieldTruthinessPredicate<S>
  | AllOfPredicate<S>
  | AnyOfPredicate<S>;

const FIELD_COMPARISON_OPS: ReadonlySet<string> = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const FIELD_TRUTHINESS_OPS: ReadonlySet<string> = new Set(["truthy", "falsy"]);

/**
 * Structural validator for a value claiming to be a {@link SymptomPredicate}
 * — the runtime backstop `TMP014` (lexicons/temporal's post-synth check)
 * re-checks a serialized rule table against, since nothing forces a rule
 * assembled by hand (rather than through the builders below) to match this
 * shape. Recurses through `allOf`/`anyOf`; `fieldWhitelist`, when given,
 * additionally refuses a field name the symptom record doesn't actually
 * produce (defense in depth over TypeScript's `keyof S` check, which only
 * applies at the author's original call site — not to a rule table replayed
 * from JSON).
 */
export function isWellFormedPredicate(value: unknown, fieldWhitelist?: ReadonlySet<string>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "field-comparison":
      return (
        typeof v.field === "string" &&
        (!fieldWhitelist || fieldWhitelist.has(v.field)) &&
        typeof v.op === "string" &&
        FIELD_COMPARISON_OPS.has(v.op) &&
        (typeof v.value === "string" || typeof v.value === "number" || typeof v.value === "boolean")
      );
    case "field-truthiness":
      return (
        typeof v.field === "string" &&
        (!fieldWhitelist || fieldWhitelist.has(v.field)) &&
        typeof v.op === "string" &&
        FIELD_TRUTHINESS_OPS.has(v.op)
      );
    case "all-of":
    case "any-of":
      return Array.isArray(v.predicates) && v.predicates.every((p) => isWellFormedPredicate(p, fieldWhitelist));
    default:
      return false;
  }
}

/** Evaluate a {@link SymptomPredicate} against a symptom record. Pure — no I/O, no ambient reads. */
export function evaluatePredicate<S>(predicate: SymptomPredicate<S>, symptom: S): boolean {
  switch (predicate.kind) {
    case "field-comparison": {
      const actual = symptom[predicate.field];
      switch (predicate.op) {
        case "eq":
          return actual === predicate.value;
        case "neq":
          return actual !== predicate.value;
        case "gt":
          return typeof actual === "number" && typeof predicate.value === "number" && actual > predicate.value;
        case "gte":
          return typeof actual === "number" && typeof predicate.value === "number" && actual >= predicate.value;
        case "lt":
          return typeof actual === "number" && typeof predicate.value === "number" && actual < predicate.value;
        case "lte":
          return typeof actual === "number" && typeof predicate.value === "number" && actual <= predicate.value;
      }
      break;
    }
    case "field-truthiness": {
      const actual = symptom[predicate.field];
      return predicate.op === "truthy" ? !!actual : !actual;
    }
    case "all-of":
      return predicate.predicates.every((p) => evaluatePredicate(p, symptom));
    case "any-of":
      return predicate.predicates.some((p) => evaluatePredicate(p, symptom));
  }
  // Unreachable for a well-formed predicate; a malformed one (bypassing the
  // builders and isWellFormedPredicate) never matches rather than throwing
  // mid-tick — the build-time check is what refuses it before this runs.
  return false;
}

// ── Predicate builders ──────────────────────────────────────────────────────

export function eq<S>(field: keyof S & string, value: string | number | boolean): FieldComparisonPredicate<S> {
  return { kind: "field-comparison", field, op: "eq", value };
}
export function neq<S>(field: keyof S & string, value: string | number | boolean): FieldComparisonPredicate<S> {
  return { kind: "field-comparison", field, op: "neq", value };
}
export function gt<S>(field: keyof S & string, value: number): FieldComparisonPredicate<S> {
  return { kind: "field-comparison", field, op: "gt", value };
}
export function gte<S>(field: keyof S & string, value: number): FieldComparisonPredicate<S> {
  return { kind: "field-comparison", field, op: "gte", value };
}
export function lt<S>(field: keyof S & string, value: number): FieldComparisonPredicate<S> {
  return { kind: "field-comparison", field, op: "lt", value };
}
export function lte<S>(field: keyof S & string, value: number): FieldComparisonPredicate<S> {
  return { kind: "field-comparison", field, op: "lte", value };
}
export function truthy<S>(field: keyof S & string): FieldTruthinessPredicate<S> {
  return { kind: "field-truthiness", field, op: "truthy" };
}
export function falsy<S>(field: keyof S & string): FieldTruthinessPredicate<S> {
  return { kind: "field-truthiness", field, op: "falsy" };
}
export function allOf<S>(...predicates: SymptomPredicate<S>[]): AllOfPredicate<S> {
  return { kind: "all-of", predicates };
}
export function anyOf<S>(...predicates: SymptomPredicate<S>[]): AnyOfPredicate<S> {
  return { kind: "any-of", predicates };
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * Dispatch a declared Op by name. `chant run <op>` — the existing local
 * runner (../op's `runOpLocally` under the hood via the CLI) — takes no
 * caller-supplied arguments today, so a dispatched Op reads whatever it
 * needs from its own declared `env`/config rather than from this rule.
 */
export interface RunAction {
  kind: "run";
  op: string;
}

/**
 * Report only — never a mutation. The log-and-ledger channel is the only one
 * v1 implements (issue open question 5): reusing `ReconcileOp`'s
 * `onDrift: "pull-request" | "issue" | "report"` channels is "obviously
 * right" per the issue, but wiring `pull-request`/`issue` through requires
 * the same reconcile plumbing `ReconcileOp` already owns — out of scope for
 * the smallest honest `ConvergeOp`. A future `channel` field can extend this
 * without a shape change.
 */
export interface ReportAction {
  kind: "report";
  reason: string;
}

export type RuleAction = RunAction | ReportAction;

export function run(op: string): RunAction {
  return { kind: "run", op };
}

export function report(reason: string): ReportAction {
  return { kind: "report", reason };
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** A rule table's default flap-damping threshold (issue: "with a default"). */
export const DEFAULT_FLAP_THRESHOLD = 3;

/**
 * One rule: a symptom predicate, the action to take when it matches, and its
 * mandatory rationale. "Every rule carries its why" (Accessible Ops factor
 * III) — `why` is a required field, not an optional one, and `when()` below
 * throws at construction (build time — the same "throw in the factory" shape
 * `ApplyOp`'s `compensate` refusal already uses) if it's missing or blank.
 */
export interface ConvergeRule<S> {
  /** Stable identifier — used for flap-damping counters, so it must not change across a rule's lifetime just because the table was reordered. */
  id: string;
  when: SymptomPredicate<S>;
  then: RuleAction;
  /** Why this rule exists — refused at build if blank. */
  why: string;
  /** Consecutive ticks the symptom may fire before this rule escalates to report-and-stop. @default {@link DEFAULT_FLAP_THRESHOLD} */
  flapThreshold?: number;
}

/**
 * Declare one converge rule. Throws immediately (build time — this runs
 * while `chant build` evaluates the authoring `*.op.ts` file, exactly like
 * `ApplyOp`'s `compensate` refusal) when `id` or `why` is missing or blank,
 * or `flapThreshold` isn't a positive integer.
 *
 * @example
 * ```ts
 * when(eq("status", "drifted"), run("fountain-apply"), {
 *   id: "drift-apply",
 *   why: "Live config drifted from declared source; re-apply converges it back.",
 * })
 * ```
 */
export function when<S>(
  predicate: SymptomPredicate<S>,
  action: RuleAction,
  opts: { id: string; why: string; flapThreshold?: number },
): ConvergeRule<S> {
  if (!opts.id || opts.id.trim().length === 0) {
    throw new Error("when(): a rule must have a non-empty `id` (used for flap-damping and diagnostics)");
  }
  if (!opts.why || opts.why.trim().length === 0) {
    throw new Error(`when("${opts.id}"): a rule must carry its \`why\` — every rule's rationale is required, refused at build otherwise`);
  }
  if (opts.flapThreshold !== undefined && (!Number.isInteger(opts.flapThreshold) || opts.flapThreshold < 1)) {
    throw new Error(`when("${opts.id}"): flapThreshold must be a positive integer`);
  }
  return {
    id: opts.id,
    when: predicate,
    then: action,
    why: opts.why,
    ...(opts.flapThreshold !== undefined ? { flapThreshold: opts.flapThreshold } : {}),
  };
}

/** Every rule id in a table must be unique — flap-damping counters and dispatch/report accounting are keyed by id. */
export function duplicateRuleIds<S>(rules: ConvergeRule<S>[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) dupes.add(r.id);
    seen.add(r.id);
  }
  return [...dupes].sort();
}
