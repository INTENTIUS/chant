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

/** Unwrap `ZodOptional`/`ZodNullable`/`ZodDefault` (and similar) down to the schema they wrap. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (typeof (current as unknown as { unwrap?: () => z.ZodTypeAny }).unwrap === "function") {
    current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
  }
  return current;
}

/** Does dot-path `path` resolve to a field that exists on `schema`? Object shapes only — an array/record return type has no fixed field set to check against. */
function pathExistsInSchema(schema: z.ZodTypeAny, path: string): boolean {
  let current = unwrap(schema);
  for (const segment of path.split(".")) {
    if (!(current instanceof z.ZodObject)) return false;
    const shape = current.shape as Record<string, z.ZodTypeAny>;
    if (!(segment in shape)) return false;
    current = unwrap(shape[segment]);
  }
  return true;
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
