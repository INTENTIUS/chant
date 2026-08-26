/**
 * Activity contracts — the Stage 1 fix for chant #1288 ("Ops are the one
 * place chant accepts untyped arguments and resolves names at runtime").
 *
 * Maintainer decision (#1288, 2026-08-25): a staged approach. Stage 1 (this
 * module) is registered args/return schemas per activity, validated by
 * `chant build` against every step — non-breaking, no change to
 * {@link ActivityStep.args}'s `Record<string, unknown>` shape or the step
 * builders. Stage 2 (a separate PR) regenerates the step builders as fully
 * typed wrappers for editor completion and go-to-definition. #1289 (op.json
 * IR) and #1290 (step-output references) build on these contracts — #1290
 * specifically needs a declared `returns` schema to validate a later step's
 * reference into an earlier one's output against, which is why `returns` is
 * part of the shape here even though nothing in Stage 1 reads it for that.
 *
 * An activity declares a contract alongside its implementation — the same
 * "registration surface" the issue asked for (`activity-registry.ts`'s
 * `collectActivities` already does this for implementations; this is the
 * schema-shaped sibling). `chant build` — via a lexicon's own post-synth
 * check, e.g. the temporal lexicon's TMP012 — resolves each step's `fn`
 * against a contract map built the same way and validates `args` and
 * `outcomeAttribute.from`. A step whose `fn` has no registered contract is
 * skipped (not an error): this is deliberately incremental — a lexicon opts
 * an activity in by declaring a contract for it, and the k8s/aws/azure/gcp/
 * fly activity sets are expected to pick this up lexicon by lexicon rather
 * than all at once (see the issue's "worth checking this lands cleanly"
 * note).
 *
 * Ownership is decentralized on purpose: each lexicon declares contracts for
 * the activities it implements and validates them with its own post-synth
 * check (the same `rulePrefix`-per-lexicon pattern every other check in
 * chant already uses), rather than a shared cross-lexicon registry. A
 * `Temporal::Op` step can call an activity contributed by any lexicon, and
 * `PostSynthContext.entities` already carries the whole resolved graph to
 * every lexicon's checks, so no new plumbing is needed for that to work.
 */

import { z } from "zod";
import type { OpConfig, PhaseDefinition, ActivityStep, StepDefinition } from "./types";

/** Every literal value {@link ActivityStep.profile} may hold. Kept in sync with `types.ts`'s `ActivityStep["profile"]`. */
export const KNOWN_ACTIVITY_PROFILES = [
  "fastIdempotent",
  "longInfra",
  "k8sWait",
  "humanGate",
  "argoSync",
  "policyCheck",
] as const;

const CONTRACT_BRAND = Symbol.for("chant.op.activityContract");

/**
 * A registered activity's args/return schemas — the declaration that lets
 * `chant build` catch a typo'd or mistyped step before it ever reaches a
 * cluster.
 *
 * Author `args` with `z.strictObject(...)` (or an equivalent that rejects
 * unrecognized keys), not `z.object(...)`. Zod's default `.object()` silently
 * drops a key it doesn't recognize instead of failing — exactly the
 * `helmInstall("api", "./chart", { nameSpace: "prod" })` failure class the
 * issue names, where the misspelled key vanishes instead of erroring. A
 * strict schema turns that into a build error.
 */
export interface ActivityContract<Args = unknown, Return = unknown> {
  readonly [CONTRACT_BRAND]: true;
  /** The activity's registered name — must match a step's `fn`. */
  name: string;
  /** Schema every step's `args` (defaulted to `{}` when omitted) must satisfy. */
  args: z.ZodType<Args>;
  /**
   * Schema the activity resolves to. Optional: an activity that returns
   * nothing meaningful (or hasn't had its return type written down yet) can
   * omit it. Needed to validate a step's `outcomeAttribute.from` path, and —
   * per #1290 — a later step's reference into this one's output.
   */
  returns?: z.ZodType<Return>;
}

/** Declare an activity contract. */
export function activityContract<ArgsSchema extends z.ZodTypeAny, ReturnSchema extends z.ZodTypeAny = never>(
  name: string,
  args: ArgsSchema,
  returns?: ReturnSchema,
): ActivityContract<z.infer<ArgsSchema>, ReturnSchema extends z.ZodTypeAny ? z.infer<ReturnSchema> : unknown> {
  return {
    [CONTRACT_BRAND]: true,
    name,
    args,
    ...(returns ? { returns } : {}),
  } as ActivityContract<z.infer<ArgsSchema>, ReturnSchema extends z.ZodTypeAny ? z.infer<ReturnSchema> : unknown>;
}

/** Structural guard for a value produced by {@link activityContract}. */
export function isActivityContract(value: unknown): value is ActivityContract {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[CONTRACT_BRAND] === true;
}

/**
 * Add every {@link ActivityContract} exported from an activity-contracts
 * module to `into`, keyed by its declared `name` — the schema-shaped sibling
 * of `activity-registry.ts`'s `collectActivities`.
 */
export function collectActivityContracts(mod: Record<string, unknown>, into: Map<string, ActivityContract>): void {
  for (const value of Object.values(mod)) {
    if (isActivityContract(value)) into.set(value.name, value);
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface ActivityContractIssue {
  /** The Op the offending step belongs to. */
  opName: string;
  /** The phase the offending step belongs to. */
  phase: string;
  /** The activity name the offending step calls. */
  fn: string;
  /** Human-readable description of the mismatch. */
  message: string;
}

/** Every `ActivityStep` in a phase, including ones nested inside an `EffectStep`. */
function activityStepsOf(steps: StepDefinition[]): ActivityStep[] {
  return steps.flatMap((s) => (s.kind === "activity" ? [s] : s.kind === "effect" ? s.steps.filter((n) => n.kind === "activity") : []));
}

// Same global symbol `step-output-ref.ts` brands a `StepOutputRef` with —
// `Symbol.for(...)` interns by string key, so this recognizes one without
// importing that module (which itself imports `pathExistsInSchema` below;
// importing the other way would make the two files a cycle).
const STEP_OUTPUT_REF_BRAND = Symbol.for("chant.op.stepOutputRef");
function isStepOutputRefValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[STEP_OUTPUT_REF_BRAND] === true;
}

/** The value at `path` (a zod issue's `.path`) inside `obj`, or `undefined` if any segment doesn't resolve. */
function valueAtPath(obj: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current = obj;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Unwrap `ZodOptional`/`ZodNullable`/`ZodDefault` (and similar) down to the schema they wrap. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (typeof (current as unknown as { unwrap?: () => z.ZodTypeAny }).unwrap === "function") {
    current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
  }
  return current;
}

/**
 * Does dot-path `path` resolve to a field that exists on `schema`? Object
 * shapes only — a return schema whose root (or an intermediate segment) is
 * a `z.record(...)`/`z.array(...)` rather than a `z.object(...)` hard-errors
 * (returns `false`) instead of skipping, deliberately (chant #1290 comment
 * on #1288's pre-merge review): a record's keys are dynamic and an array's
 * elements are index-addressed, neither of which a dot-path segment can
 * check against in any way that's more meaningful than "the author probably
 * meant something else." No declared `returns` schema needs this today, so
 * there's no live case to design against yet. The escape hatch is an empty
 * path — `outcomeAttribute.from` omitted, or a {@link StepOutputRef}'s
 * `path` omitted — which references the whole return value and never calls
 * this function; a record/array-returning activity's whole value is always
 * a valid reference target.
 */
export function pathExistsInSchema(schema: z.ZodTypeAny, path: string): boolean {
  return schemaAtPath(schema, path.split(".")) !== undefined;
}

/**
 * The zod schema at property-key path `path` inside `schema`, walking
 * through `z.ZodObject` shapes only (unwrapping optional/nullable/default at
 * each level, same as {@link pathExistsInSchema}). `undefined` when a
 * segment doesn't resolve, or an intermediate schema isn't a `z.ZodObject` —
 * same record/array hard-stop {@link pathExistsInSchema} documents. An empty
 * `path` returns `schema` itself (unwrapped).
 */
export function schemaAtPath(schema: z.ZodTypeAny, path: ReadonlyArray<string>): z.ZodTypeAny | undefined {
  let current = unwrap(schema);
  for (const segment of path) {
    if (!(current instanceof z.ZodObject)) return undefined;
    const shape = current.shape as Record<string, z.ZodTypeAny>;
    if (!(segment in shape)) return undefined;
    current = unwrap(shape[segment]);
  }
  return current;
}

/**
 * A primitive-shape classification of a zod schema — `string`/`number`/
 * `boolean`/`object`/`array`, or `undefined` for anything else (a union,
 * enum, literal, `z.any()`/`z.unknown()`, a transform, …). Used by the
 * step-output-ref cross-contract type check (chant #1950-3) to compare a
 * producer's declared return type against a consumer's declared arg type at
 * the same structural position — deliberately shallow: it bails (returns
 * `undefined`) on anything fancier than these five kinds rather than trying
 * to reason about it, per that check's "bail out silently" design.
 */
export type PrimitiveSchemaKind = "string" | "number" | "boolean" | "object" | "array";

export function primitiveKindOf(schema: z.ZodTypeAny): PrimitiveSchemaKind | undefined {
  const s = unwrap(schema);
  if (s instanceof z.ZodString) return "string";
  if (s instanceof z.ZodNumber) return "number";
  if (s instanceof z.ZodBoolean) return "boolean";
  if (s instanceof z.ZodObject) return "object";
  if (s instanceof z.ZodArray) return "array";
  return undefined;
}

/**
 * Validate every activity step in an Op's phases (main and `onFailure`)
 * against a contract map. A step whose `fn` has no entry in `contracts` is
 * skipped — Stage 1 is opt-in per activity, not a hard requirement that
 * every activity have a declared contract.
 *
 * Catches the four failure classes chant #1288 names:
 *  - an unrecognized `profile` (checked against {@link KNOWN_ACTIVITY_PROFILES}, independent of whether `fn` has a contract),
 *  - an args key the declared schema doesn't recognize,
 *  - an args value of the wrong type (including a required key that's missing),
 *  - an `outcomeAttribute.from` path that can't exist on the declared return type.
 */
export function validateActivitySteps(
  config: Pick<OpConfig, "name" | "phases" | "onFailure">,
  contracts: ReadonlyMap<string, ActivityContract>,
): ActivityContractIssue[] {
  const issues: ActivityContractIssue[] = [];
  const phasesToWalk: PhaseDefinition[] = [...config.phases, ...(config.onFailure ?? [])];

  for (const phase of phasesToWalk) {
    for (const step of activityStepsOf(phase.steps)) {
      if (step.profile && !(KNOWN_ACTIVITY_PROFILES as readonly string[]).includes(step.profile)) {
        issues.push({
          opName: config.name,
          phase: phase.name,
          fn: step.fn,
          message: `unknown profile "${step.profile}" (known: ${KNOWN_ACTIVITY_PROFILES.join(", ")})`,
        });
      }

      const contract = contracts.get(step.fn);
      if (!contract) continue;

      const parsed = contract.args.safeParse(step.args ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          // A step-output reference (#1290) sitting at this path is a
          // placeholder object at build time, not the value it will
          // resolve to — so an args-schema type mismatch here is a false
          // positive; TMP013 (`validateStepOutputRefs`) is what validates
          // a reference, against the *producer's* declared return schema.
          // An unrecognized-key issue's path is the parent object (`[]`
          // for a top-level extra key), which is never itself a reference,
          // so a genuinely misspelled key is still caught either way.
          if (isStepOutputRefValue(valueAtPath(step.args, issue.path))) continue;
          const path = issue.path.length > 0 ? issue.path.join(".") : "(args)";
          issues.push({ opName: config.name, phase: phase.name, fn: step.fn, message: `args.${path}: ${issue.message}` });
        }
      }

      if (step.outcomeAttribute?.from && contract.returns && !pathExistsInSchema(contract.returns, step.outcomeAttribute.from)) {
        issues.push({
          opName: config.name,
          phase: phase.name,
          fn: step.fn,
          message: `outcomeAttribute.from "${step.outcomeAttribute.from}" does not exist on "${step.fn}"'s declared return type`,
        });
      }
    }
  }

  return issues;
}
