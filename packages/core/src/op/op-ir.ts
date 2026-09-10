/**
 * op.json IR — chant #1289 ("An Op compiles only to TypeScript, so walk-away
 * cost is zero everywhere except Ops").
 *
 * `OpConfig` is already inert data: every field is a string, number, boolean,
 * or a nested object of those (no functions, no closures, no runtime
 * references — see `./types.ts`). This module is the "second, simpler output
 * from the same walk" the issue asks for: a deterministic
 * `dist/ops/<name>/op.json`, so a foreign runtime (or a dashboard, a policy
 * check, an agent) can read what an Op does without importing chant or
 * parsing generated TypeScript.
 *
 * It lives in core, not in a hosting lexicon (#2118, epic #2114). The IR is a
 * restatement of `OpConfig`, and `OpConfig` is core's — as is the profile
 * table a step's `profile` key names, since #2117. What core does not own is
 * the activity contracts that give a step's args a schema: those stay
 * decentralized, so `buildOpIR` takes the registry as a parameter and defaults
 * it to empty. A caller holding a lexicon's contracts passes them in, and the
 * `activityContracts` section fills out without core ever importing that
 * lexicon.
 *
 * Two things beyond a literal restatement of `OpConfig` earn their place:
 *
 *  - Every step's `profile` / gate `timeout` is resolved to its effective
 *    value (chant's own default when omitted), and every referenced profile's
 *    actual retry/timeout policy rides along out of `ACTIVITY_PROFILES`.
 *    Without it a foreign runtime would have to read chant's TypeScript to
 *    know what "fastIdempotent" means.
 *  - Every step whose `fn` has a registered {@link ActivityContract} in the
 *    contract registry the caller passes (chant #1288 Stage 1) gets its args/
 *    returns zod schema embedded as JSON Schema (via zod 4's built-in
 *    `z.toJSONSchema`), keyed by activity name. This is exactly the payoff
 *    the Stage 1 decision comment named: "#1289 (op.json IR) ... build on
 *    these [Stage 1] contracts." Ownership stays decentralized — only
 *    activities the passed registry knows are covered; a step calling an
 *    activity from a lexicon outside it (or one with no registered contract
 *    yet) simply has no entry here.
 *  - Every step whose contract declares entity-identifying args
 *    (`ActivityContract.entities`, chant #2022) gets those args' literal
 *    string values resolved into `entities` — the estate join a renderer
 *    otherwise had to invent off scope fields like `stackName`. The contract
 *    entry echoes the declared key list, so a consumer can resolve values
 *    this serialization could not (a step-output ref) itself.
 *    JSON-Schema-incompatible contracts (schemas containing transforms or
 *    custom types that zod cannot serialize) are skipped gracefully: the
 *    activity appears in the Op's step graph but has no entry in
 *    activityContracts, consistent with the decentralized and partial
 *    coverage philosophy.
 *
 * Resolving defaults loses nothing: parsing `op.json` back into an
 * `OpConfig`-shaped object (`opConfigFromIR`) and re-serializing it produces
 * a byte-identical `op.json`, and a lexicon serializer fed the reconstruction
 * emits byte-identical code (verified by the round-trip tests here) — the
 * issue's own verification criterion.
 *
 * ## Step-output references (chant #1290, #1288 Stage 2 follow-up)
 *
 * A step's `args` may hold a {@link StepOutputRef} (`./step-output-ref.ts`)
 * anywhere in its structure — a placeholder for a
 * prior step's declared return value, which the executor substitutes for at
 * run time from the producing step's record. This module does not
 * special-case it: `irActivityStep` copies `step.args` through as-is (same as
 * every other value), and `JSON.stringify` — both the literal one in
 * `serializeOpIR` and the structural-equality one `z.toJSONSchema`-adjacent
 * consumers would use — drops a `StepOutputRef`'s brand (a `Symbol.for(...)`
 * key; JSON has no symbols) while keeping its three own enumerable string
 * properties. The result is a plain, first-class IR value at exactly the
 * position the reference sat in `args`:
 *
 * ```json
 * { "kind": "step-output-ref", "step": "build-step", "path": "manifestPath" }
 * ```
 *
 * (`path` omitted when the reference is to the whole return value.) This is
 * deliberate, not an accident of `JSON.stringify`'s symbol-dropping — a
 * foreign consumer of op.json can match on `args.<field>.kind ===
 * "step-output-ref"` to recognize a placeholder and resolve it against
 * `steps[].id`/`activityContracts[fn].returns` itself, without ever loading
 * chant's TypeScript. `op-ir.test.ts` asserts the shape directly so a future
 * change to `StepOutputRef`'s own fields (`./step-output-ref.ts`) that would
 * silently change this JSON shape gets caught here.
 */

import { z } from "zod";
import type {
  OutcomeAttribute,
  OpConfig,
  OpSchedule,
  PhaseDefinition,
  StepDefinition,
  ActivityStep,
  GateStep,
  EffectStep,
} from "./types";
import type { EffectReceiptRef } from "./receipt-store";
import type { ActivityContract } from "./activity-contract";
import { ACTIVITY_PROFILES, type ActivityProfile } from "./activity-profiles";
import { gateName } from "./gate-name";

/**
 * The op.json IR schema version. Bumped on a breaking change to this
 * module's output shape — additive fields (a new optional key) do not
 * require a bump.
 *
 * `2.0` (#2118): `taskQueue` and `namespace` are gone and `searchAttributes`
 * is replaced by `labels`. Those three were the fields only a workflow engine
 * read; an op.json now states what the Op does, not where it runs.
 */
export const OP_IR_FORMAT_VERSION = "2.0";

// ── IR shape ──────────────────────────────────────────────────────────────────

export interface OpIRActivityStep {
  kind: "activity";
  fn: string;
  /** Always present (defaulted to `{}`) — unlike `ActivityStep.args`, which omits an empty bag. */
  args: Record<string, unknown>;
  /** Resolved to its effective value — `ActivityStep.profile ?? "fastIdempotent"`. */
  profile: string;
  /**
   * What this step's effect touches in the estate (#2022): the string values
   * of the args its contract declares as entity-identifying
   * (`ActivityContract.entities`), resolved per step at serialization the
   * same way `profile` is. Absent when the activity has no contract, the
   * contract declares no entity args, or none of them holds a literal string
   * in this step (a step-output ref resolves at run time, not here).
   */
  entities?: string[];
  /** One run outcome, or several published off the same result (#2105). */
  outcomeAttribute?: OutcomeAttribute | OutcomeAttribute[];
}

export interface OpIRGateStep {
  kind: "gate";
  /** The gate's name — `GateStep.gate`, or its deprecated `signalName` spelling (#2202). */
  gate: string;
  /** Resolved to its effective value — `GateStep.timeout ?? "48h"`. */
  timeout: string;
  description?: string;
  /**
   * The plan this gate approves (#2300) — a digest string, or a
   * {@link StepOutputRef} placeholder a foreign runtime resolves from the
   * named step's result the same way it resolves one in an activity's args.
   * Absent on a gate that binds no plan.
   */
  plan?: GateStep["plan"];
}

export interface OpIREffectStep {
  kind: "effect";
  receipt: EffectReceiptRef;
  expectation?: string;
  steps: Array<OpIRActivityStep | OpIRGateStep>;
  description?: string;
}

export type OpIRStep = OpIRActivityStep | OpIRGateStep | OpIREffectStep;

export interface OpIRPhase {
  name: string;
  parallel: boolean;
  steps: OpIRStep[];
}

/** A registered activity contract's args/returns, restated as JSON Schema. */
export interface OpIRActivityContract {
  args: Record<string, unknown>;
  returns?: Record<string, unknown>;
  /** Names of args the contract declares as entity-identifying (#2022) — the key a consumer uses to resolve entities out of any step's `args` itself, including values this serialization could not (a step-output ref). */
  entities?: string[];
}

export interface OpIR {
  formatVersion: string;
  name: string;
  overview: string;
  depends: string[];
  /** The Op's discovery keys (#2118) — `OpConfig.labels` verbatim, `{}` when it declares none. */
  labels: Record<string, string>;
  /**
   * The Op's cadence (#2120) — `OpConfig.schedule` verbatim, absent when it
   * declares none. Op data, not runtime data: the cron says how often this Op
   * should run, and which scheduler honours it is the reader's business, the
   * same way `profile` states a retry policy without naming a retrier. An
   * additive optional key, so it needs no `formatVersion` bump.
   */
  schedule?: OpSchedule;
  phases: OpIRPhase[];
  onFailure: OpIRPhase[];
  /** Every activity profile referenced by a step in this Op, keyed by profile name — from the registry passed to {@link buildOpIR}, empty when none was. */
  activityProfiles: Record<string, ActivityProfile>;
  /**
   * JSON Schema for every referenced activity that has a registered contract
   * in the passed registry (chant #1288 Stage 1). Decentralized and partial
   * by design — see the module doc.
   */
  activityContracts: Record<string, OpIRActivityContract>;
}

// ── Step helpers ──────────────────────────────────────────────────────────────

function effectiveProfile(step: ActivityStep): string {
  return step.profile ?? "fastIdempotent";
}

/**
 * The step's entity-identifying arg values (#2022): the literal strings at
 * the arg names its contract declares in `entities`. A non-string there (a
 * step-output ref placeholder, a structured value) is skipped — the IR only
 * states joins it can resolve at serialization; a consumer holding the
 * contract's own `entities` key list can resolve the rest itself.
 */
function stepEntities(step: ActivityStep, contracts: ReadonlyMap<string, ActivityContract>): string[] | undefined {
  const declared = contracts.get(step.fn)?.entities;
  if (!declared || declared.length === 0) return undefined;
  const values: string[] = [];
  for (const key of declared) {
    const value = (step.args ?? {})[key];
    if (typeof value === "string") values.push(value);
  }
  return values.length > 0 ? values : undefined;
}

function irActivityStep(step: ActivityStep, contracts: ReadonlyMap<string, ActivityContract>): OpIRActivityStep {
  const entities = stepEntities(step, contracts);
  return {
    kind: "activity",
    fn: step.fn,
    args: step.args ?? {},
    profile: effectiveProfile(step),
    ...(entities ? { entities } : {}),
    ...(step.outcomeAttribute ? { outcomeAttribute: step.outcomeAttribute } : {}),
  };
}

function irGateStep(step: GateStep): OpIRGateStep {
  return {
    kind: "gate",
    gate: gateName(step),
    timeout: step.timeout ?? "48h",
    ...(step.description ? { description: step.description } : {}),
    ...(step.plan !== undefined ? { plan: step.plan } : {}),
  };
}

function irEffectStep(step: EffectStep, contracts: ReadonlyMap<string, ActivityContract>): OpIREffectStep {
  return {
    kind: "effect",
    receipt: step.receipt,
    ...(step.expectation !== undefined ? { expectation: step.expectation } : {}),
    steps: step.steps.map((s) => (s.kind === "activity" ? irActivityStep(s, contracts) : irGateStep(s))),
    ...(step.description ? { description: step.description } : {}),
  };
}

function irStep(step: StepDefinition, contracts: ReadonlyMap<string, ActivityContract>): OpIRStep {
  if (step.kind === "activity") return irActivityStep(step, contracts);
  if (step.kind === "gate") return irGateStep(step);
  return irEffectStep(step, contracts);
}

function irPhase(phase: PhaseDefinition, contracts: ReadonlyMap<string, ActivityContract>): OpIRPhase {
  return {
    name: phase.name,
    parallel: phase.parallel ?? false,
    steps: phase.steps.map((s) => irStep(s, contracts)),
  };
}

// ── Referenced-activity collection ─────────────────────────────────────────────

/** Every `ActivityStep` reachable from a phase list, including ones nested inside an `EffectStep`. */
function activityStepsOf(phases: PhaseDefinition[]): ActivityStep[] {
  const out: ActivityStep[] = [];
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.kind === "activity") out.push(step);
      else if (step.kind === "effect") {
        for (const nested of step.steps) if (nested.kind === "activity") out.push(nested);
      }
    }
  }
  return out;
}

/** No contracts unless a caller supplies them — core does not own that registry. See the module doc. */
const NO_CONTRACTS: ReadonlyMap<string, ActivityContract> = new Map();

/** Sort object keys for a set-like dictionary without a meaningful authored order (profiles/contracts, keyed by name). */
function sortedEntries<T>(map: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key)!;
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the deterministic op.json IR for one Op's config.
 *
 * `contractRegistry` is the one thing core does not own (see the module doc):
 * a caller holding a lexicon's activity contracts passes them in and
 * `activityContracts` fills out. Omitted, that section is empty — the step
 * graph, the labels and every step's resolved `profile` name are unaffected
 * either way. `profileRegistry` defaults to core's own `ACTIVITY_PROFILES`;
 * a test overrides it.
 */
export function buildOpIR(
  config: OpConfig,
  contractRegistry: ReadonlyMap<string, ActivityContract> = NO_CONTRACTS,
  profileRegistry: Readonly<Record<string, ActivityProfile>> = ACTIVITY_PROFILES,
): OpIR {
  const allSteps = [...activityStepsOf(config.phases), ...activityStepsOf(config.onFailure ?? [])];

  const profiles = new Map<string, ActivityProfile>();
  const contracts = new Map<string, OpIRActivityContract>();
  for (const step of allSteps) {
    const prof = effectiveProfile(step);
    if (!profiles.has(prof) && prof in profileRegistry) {
      profiles.set(prof, profileRegistry[prof]);
    }
    if (!contracts.has(step.fn)) {
      const contract = contractRegistry.get(step.fn);
      if (contract) {
        try {
          const args = z.toJSONSchema(contract.args) as Record<string, unknown>;
          const returns = contract.returns ? (z.toJSONSchema(contract.returns) as Record<string, unknown>) : undefined;
          contracts.set(step.fn, {
            args,
            ...(returns ? { returns } : {}),
            ...(contract.entities && contract.entities.length > 0 ? { entities: contract.entities } : {}),
          });
        } catch {
          // zod 4's toJSONSchema throws on schemas containing transforms or custom types.
          // Gracefully skip this contract — the activity remains in the step graph but
          // has no entry in activityContracts. Consistent with the decentralized and
          // partial coverage philosophy.
        }
      }
    }
  }

  return {
    formatVersion: OP_IR_FORMAT_VERSION,
    name: config.name,
    overview: config.overview,
    depends: config.depends ?? [],
    labels: config.labels ?? {},
    ...(config.schedule ? { schedule: config.schedule } : {}),
    phases: config.phases.map((p) => irPhase(p, contractRegistry)),
    onFailure: (config.onFailure ?? []).map((p) => irPhase(p, contractRegistry)),
    activityProfiles: sortedEntries(profiles),
    activityContracts: sortedEntries(contracts),
  };
}

/** Serialize one Op's op.json IR to a deterministic JSON string (stable key order, 2-space indent, trailing newline). Takes the same two optional registries as {@link buildOpIR}. */
export function serializeOpIR(
  config: OpConfig,
  contractRegistry?: ReadonlyMap<string, ActivityContract>,
  profileRegistry?: Readonly<Record<string, ActivityProfile>>,
): string {
  return JSON.stringify(buildOpIR(config, contractRegistry, profileRegistry), null, 2) + "\n";
}

// ── Round trip (op.json → OpConfig) ────────────────────────────────────────────
//
// The inverse of `buildOpIR`. Exists primarily to prove the IR's own
// verification criterion (chant #1289): parsing `op.json` back into an
// `OpConfig`-shaped object and re-serializing it round-trips byte-identically,
// and a lexicon serializer fed the reconstruction emits identical code. Also
// the mechanical shape a foreign consumer would use to drive its own executor
// off the IR rather than the generated TypeScript.

function opStepFromIR(step: OpIRStep): StepDefinition {
  if (step.kind === "activity") {
    return {
      kind: "activity",
      fn: step.fn,
      args: step.args,
      profile: step.profile as ActivityStep["profile"],
      ...(step.outcomeAttribute ? { outcomeAttribute: step.outcomeAttribute } : {}),
    };
  }
  if (step.kind === "gate") {
    return {
      kind: "gate",
      gate: step.gate,
      timeout: step.timeout,
      ...(step.description ? { description: step.description } : {}),
      ...(step.plan !== undefined ? { plan: step.plan } : {}),
    };
  }
  return {
    kind: "effect",
    receipt: step.receipt,
    ...(step.expectation !== undefined ? { expectation: step.expectation } : {}),
    steps: step.steps.map((s) => opStepFromIR(s) as ActivityStep | GateStep),
    ...(step.description ? { description: step.description } : {}),
  };
}

function opPhaseFromIR(phase: OpIRPhase): PhaseDefinition {
  return {
    name: phase.name,
    steps: phase.steps.map(opStepFromIR),
    ...(phase.parallel ? { parallel: true } : {}),
  };
}

/** Reconstruct an `OpConfig` from its op.json IR. */
export function opConfigFromIR(ir: OpIR): OpConfig {
  if (ir.formatVersion !== OP_IR_FORMAT_VERSION) {
    throw new Error(
      `op.json IR format mismatch: expected "${OP_IR_FORMAT_VERSION}", got "${ir.formatVersion}". ` +
      `This op.json may be stale or from a newer chant version.`,
    );
  }
  return {
    name: ir.name,
    overview: ir.overview,
    phases: ir.phases.map(opPhaseFromIR),
    ...(ir.depends.length > 0 ? { depends: ir.depends } : {}),
    ...(ir.onFailure.length > 0 ? { onFailure: ir.onFailure.map(opPhaseFromIR) } : {}),
    ...(Object.keys(ir.labels).length > 0 ? { labels: ir.labels } : {}),
    ...(ir.schedule ? { schedule: ir.schedule } : {}),
  };
}
