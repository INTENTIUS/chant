/**
 * The behaviour prediction contract (#2356) — what a lexicon's
 * `predictBehaviour()` is allowed to mean.
 *
 * `describeResources()` (./observation.ts) answers whether a declared entity
 * exists. `observeResourcesDeep()` (./deep-observation.ts) answers what its
 * properties currently are. Both report facts a substrate was asked for. This
 * third axis reports something no substrate holds: what the declared estate
 * would *do* at a stated traffic level — cost per hour, how far each entity is
 * from saturation, the error rate to expect, whether it survives a named
 * failure, and a smaller size that would still carry the load.
 *
 * None of that is a measurement, and the type is built so it cannot be read as
 * one.
 *
 * ## A prediction is not a bill
 *
 * The one failure mode that matters here is somebody quoting a modeled figure
 * as money owed. Four things in this module work against that, and it is worth
 * being exact about how much they buy, because an overstated guarantee is how
 * a consumer ends up trusting one:
 *
 *   1. Money appears in exactly one shape, {@link PredictedRate}, and that
 *      shape carries a literal `rate: "per-hour"` discriminant. There is no
 *      field anywhere for an amount, a period, an account, an invoice or a
 *      due date, so an elapsed charge is not expressible *in this module's
 *      types*.
 *   2. A figure cannot exist without {@link PredictedBehaviour.at}, the traffic
 *      level it was predicted for. A bill is for an hour that happened; this is
 *      for an hour the engine was asked to imagine.
 *   3. {@link BehaviourProvenance} is required on every entity, and its
 *      {@link BehaviourProvenance.basis} is a closed two-value enum: `modeled`
 *      off list prices, or `validated` against a real bill. A figure that will
 *      not say which of the two it is cannot be constructed.
 *   4. A refusal is a separate member of the {@link BehaviourResult} union with
 *      no figures on it at all, so "the engine is gone" and "the engine says
 *      zero" are different objects rather than the same object with zeroes in
 *      it. This one is airtight: there is no `entities` key on the refusal arm
 *      to be empty and no total to be zero.
 *
 * **What this does not do is make a bill a type error.** A consumer holding a
 * {@link PredictedBehaviour} can write
 * `const { rate, ...rest } = cost; return { amount: rest.perHour * hours }`
 * and TypeScript will not object; the discriminant is a field on an object, and
 * a field can be dropped. behold's own validator rebuilds `cost` as
 * `{ perHour, currency }` and its estate sum carries no discriminant at all, so
 * the marker is stripped by the first consumer *by design*. What the shape
 * genuinely buys is that a bill cannot be constructed **accidentally** — every
 * route from a prediction to something that reads as money owed has a
 * deliberate destructure or cast in it, and shows up in review as one. Treat
 * rules 1 to 3 as a speed bump with a name, and rule 4 as the enforced one.
 *
 * ## The engine sees no credential and writes nothing
 *
 * {@link PredictBehaviourOptions} mirrors `observeResourcesDeep`'s options
 * field for field, plus `traffic`, `edges` and `edgeCoverage`, and then works
 * against credentials on two levels. The type declares every obvious name
 * `?: never`, which catches the deliberate attempt; and
 * {@link assertNoCredentialInOptions} walks the whole request at runtime,
 * matching credential-shaped **values** as well as credential-shaped keys,
 * which is what catches the accident.
 *
 * The runtime walk is the load-bearing half, because the type cannot see the
 * two channels that actually carry a secret in practice:
 * `entities[*].props` is `Record<string, unknown>` straight out of the build,
 * and a lexicon surfacing a connection string puts one there without deciding
 * to. See {@link assertNoCredentialInOptions} for exactly what the walk detects
 * and, more importantly, what it does not.
 *
 * `edges` is the one place the options mirror breaks, and the field's own doc
 * says why: the epic's input is a resource graph, a deep read has no use for
 * neighbours, and a prediction is nothing but statements about paths through
 * the estate. It carries `IREdge` (./graph-ir.ts) rather than an edge type of
 * this contract's own, because that is already the shape both the declared
 * path and the live path produce.
 *
 * Nothing in the options is a handle. There is no client, no transport, no
 * apply callback, no writer — only strings, a name list and the entity map the
 * build already produced. An engine handed this cannot reach the account even
 * if it wanted to, which is the structural half of "it never writes".
 *
 * ## The tri-state, and why it is not `UnobservedReason`
 *
 * Behaviour keeps the same three-verdict discipline `./observation.ts`
 * established — PREDICTED, NOT-PREDICTABLE-FOR-THIS-KIND, and NOT-PREDICTED
 * with a named reason — but on a stricter total: every entity the caller asked
 * about lands in `entities` or in `unpredicted`, never in neither. The thin
 * read needs a third position because "the provider says it is not there" is a
 * real answer with no row to sit on. A prediction has no such answer. An entity
 * either got a figure or it did not, and when it did not there is a reason,
 * so an entity in neither map means the lexicon lost track of it.
 *
 * {@link BehaviourUnpredictedReason} derives from `UnobservedReason` rather
 * than restating it, so the four shared verdicts provably keep their spelling
 * and their meaning. It differs in two ways, both deliberate:
 *
 *   - `no-credentials` is **excluded**. A behaviour read has no credential to
 *     be missing — see the section above — so an enum that could say it would
 *     be inviting a lexicon to send an operator hunting for a variable this
 *     contract forbids.
 *   - Four reasons about the predictor itself are **added** — `no-engine`,
 *     `engine-unreachable`, `engine-out-of-credit` and `engine-over-quota` —
 *     because the epic wants a missing engine named and `no-binding` is about
 *     the environment resolving to no target, a different axis. They are four
 *     rather than one because each has a different remedy, and a refusal that
 *     names the wrong remedy is worse than a slow one: set a variable, check an
 *     address, pay for the account, or wait for a window. The last two arrive
 *     from an engine that answered perfectly well (#2359), so folding them into
 *     `engine-unreachable` would send somebody to debug a network that is fine.
 *
 * ## Deltas: the invariant is here, the presentation is not
 *
 * The epic wants a declared prediction and a live prediction shown as a delta,
 * and #2358 posts one on a merge request. This module deliberately ships no
 * delta type and no differencing function. What it ships is the one thing a
 * hand-rolled diff silently loses, which is that a figure's context does not
 * survive subtraction: {@link compareFigures} classifies a pair `comparable`,
 * `mixed-basis`, `mixed-level` or `mixed-engine`, and the rule this contract
 * binds its consumers to is that anything but `comparable` must be marked
 * wherever it is shown. A `modeled` figure minus a `validated` one is not a
 * change in the estate; part of that difference is the gap between a price list
 * and an invoice. Nor is a 100 rps figure minus a 1000 rps one, which is why
 * {@link compareProvenance} — which cannot see `at` and never could — is not
 * the function to reach for. How the mark looks is #2358's to define. Whether
 * there is one is not.
 *
 * ## Shape compatibility with the overlay
 *
 * {@link PredictedBehaviour} is the object `chant graph --live --overlay` puts
 * on a node as `attrs._behaviour`.
 *
 * On the graph, `meta._behaviour` takes {@link BehaviourReportMeta} **or the
 * whole {@link BehaviourRefusalReport}** — not a bare {@link BehaviourRefusal}.
 * behold reads that key as `{ engine?, version?, at?, total?, refusal? }` and
 * branches on the presence of `refusal`, so a bare `BehaviourRefusal` has no
 * `refusal` key, falls through to the engine check, and is dropped as
 * "meta.engine missing" — a refusal that renders as nothing at all, which is
 * the one outcome this contract exists to prevent. #2360 implements this
 * sentence, so it says what behold does.
 *
 * behold reads those keys and does arithmetic on the engine's figures; it never
 * produces one of its own. Fields beyond what it reads (`cause` and `source` on
 * a refusal, `edgeCoverage` on the meta) are additive and ignorable.
 */

import type { UnobservedReason } from "./observation";
import type { IREdge } from "./graph-ir";
import type { DanglingRef } from "./graph-refs";
import {
  CREDENTIAL_ENV_NAME,
  CREDENTIAL_SHAPES,
  CREDENTIAL_TOKEN_SHAPES,
  REDACTED,
  redactCredentialMaterial,
} from "./identity";

/**
 * Whether a figure came off a price list or off a bill. Closed, and required on
 * every prediction — this is the distinction that keeps rule 1 enforceable.
 *
 * - `modeled` — computed from published list prices and the engine's own model.
 *   The honest default, and the word a badge shows unless told otherwise.
 * - `validated` — reconciled against a real invoice for a comparable estate.
 */
export type BehaviourBasis = "modeled" | "validated";

/**
 * Every legal {@link BehaviourBasis}, for validation and conformance checks.
 *
 * Derived from a total witness rather than typed as `readonly BehaviourBasis[]`
 * and written out by hand. A hand-written array is only checked for having
 * legal members, never for having ALL of them, so a value added to the union
 * leaves the array silently short and every runtime guard built on it starts
 * rejecting a value the type accepts. Keying a `Record` off the union makes the
 * omission a compile error at the point of the omission. Same construction for
 * {@link RESILIENCE_VERDICTS} and {@link BEHAVIOUR_UNPREDICTED_REASONS}, and
 * the last of those is the one that needed it: it derives from
 * `UnobservedReason`, so a reason added *upstream* would otherwise widen this
 * type with nothing here failing.
 */
const BEHAVIOUR_BASIS_WITNESS: Record<BehaviourBasis, true> = {
  modeled: true,
  validated: true,
};

export const BEHAVIOUR_BASES: readonly BehaviourBasis[] = Object.keys(
  BEHAVIOUR_BASIS_WITNESS,
) as BehaviourBasis[];

/** True when `value` is a legal {@link BehaviourBasis}. */
export function isBehaviourBasis(value: unknown): value is BehaviourBasis {
  return typeof value === "string" && (BEHAVIOUR_BASES as readonly string[]).includes(value);
}

/**
 * Where one entity's numbers came from and how far they can be trusted.
 * Required on every {@link PredictedBehaviour}, and per entity rather than per
 * report, because one estate can be priced by two engines.
 */
export interface BehaviourProvenance {
  /** The engine that produced the figures, as it names itself (`acme-sim`). */
  engine: string;
  /** That engine's own version string (`1.4.2`). Never inferred. */
  version: string;
  /**
   * The engine's stated tolerance, echoed verbatim (`±15%`). chant does not
   * parse it and does not invent one for an engine that states none — an engine
   * with nothing to say here has no business publishing a figure.
   */
  tolerance: string;
  /** List prices, or a real bill. See {@link BehaviourBasis}. */
  basis: BehaviourBasis;
}

/**
 * The traffic level a prediction is for. A string the engine names and chant
 * echoes, never a number chant does arithmetic on: `100 rps, p50`, `peak hour,
 * black friday`, `steady state`. Required, because a figure without the
 * question it answers is the figure most likely to be quoted as a bill.
 */
export interface BehaviourTrafficLevel {
  traffic: string;
}

/**
 * Money, in the only shape this module has for it: a rate for one hypothetical
 * hour at a stated traffic level.
 *
 * The literal `rate: "per-hour"` is load-bearing. It makes the type structurally
 * distinct from any billing record — nothing that models an amount charged
 * carries that field — so a `PredictedRate` cannot be passed where a charge is
 * wanted, and a charge cannot be passed here.
 */
export interface PredictedRate {
  /** Discriminant. A rate for an imagined hour, never an amount charged for a real one. */
  readonly rate: "per-hour";
  /** The rate itself, in `currency` per hour. */
  perHour: number;
  /** ISO 4217 code, as the engine states it. chant converts nothing. */
  currency: string;
}

/** Build a {@link PredictedRate}. Lexicons use this rather than writing the discriminant by hand. */
export function predictedRate(perHour: number, currency: string): PredictedRate {
  return { rate: "per-hour", perHour, currency };
}

/**
 * How much of each axis is still free at the stated traffic level, as a
 * fraction in `0..1`. Both axes are optional and an axis the engine does not
 * model is **absent**, never `0` — zero headroom means saturated, which is the
 * opposite claim.
 */
export type BehaviourHeadroom =
  | { cpu: number; latency?: number }
  | { cpu?: number; latency: number };

/** What an entity does when the named failure happens. Closed. */
export type ResilienceVerdict = "survives" | "degrades" | "fails";

const RESILIENCE_VERDICT_WITNESS: Record<ResilienceVerdict, true> = {
  survives: true,
  degrades: true,
  fails: true,
};

/** Every legal {@link ResilienceVerdict}, for validation and conformance checks. */
export const RESILIENCE_VERDICTS: readonly ResilienceVerdict[] = Object.keys(
  RESILIENCE_VERDICT_WITNESS,
) as ResilienceVerdict[];

/** True when `value` is a legal {@link ResilienceVerdict}. */
export function isResilienceVerdict(value: unknown): value is ResilienceVerdict {
  return typeof value === "string" && (RESILIENCE_VERDICTS as readonly string[]).includes(value);
}

/** The verdict under one named failure, and which failure it was tested against. */
export interface BehaviourResilience {
  /**
   * The failure, named by the engine and echoed verbatim: `one zone lost`,
   * `primary database failover`. A verdict without its failure says nothing.
   */
  failure: string;
  verdict: ResilienceVerdict;
  /** Free text from the engine, when it has more to say than the verdict. */
  note?: string;
}

/** A smaller size the engine believes would still carry the stated traffic. */
export interface BehaviourRightSize {
  /** The size, in the provider's own vocabulary (`t3.small`, `db-f1-micro`). */
  suggestion: string;
  /** Why. A suggestion nobody can evaluate is noise. */
  reason?: string;
}

/**
 * One entity's prediction — the object that rides as `attrs._behaviour` on an
 * overlay node.
 *
 * Everything here except `rightSize`, `resilience.note` and either
 * {@link BehaviourHeadroom} axis is required. An entity the engine could not
 * price does not get a thinned-out version of this block; it goes in
 * {@link BehaviourReport.unpredicted} with a reason.
 */
export interface PredictedBehaviour {
  /** The traffic level every figure below is for. */
  at: BehaviourTrafficLevel;
  /** Cost per hour at `at`. */
  cost: PredictedRate;
  /** Distance from saturation at `at`. A modeled axis is present; an unmodeled one is absent. */
  headroom: BehaviourHeadroom;
  /** Expected fraction of requests failing at `at`, in `0..1`. */
  errorRate: number;
  /** The verdict under a named failure. */
  resilience: BehaviourResilience;
  /** Optional: a smaller size that would still do. */
  rightSize?: BehaviourRightSize;
  /** Which engine said all of this, and on what basis. Required. */
  provenance: BehaviourProvenance;
}

/**
 * Why one declared entity got no prediction. Total: a lexicon that cannot
 * predict an entity must pick one of these, and consumers may switch
 * exhaustively.
 *
 * Derived from {@link UnobservedReason} so the four shared verdicts keep their
 * exact spelling and meaning:
 *
 * - `read-failed` — the engine was reached and the prediction errored.
 * - `no-binding` — the environment resolves to no concrete target to predict.
 * - `unsupported-kind` — the engine has no model for this entity type. The
 *   entity is perfectly real and may well cost money; this engine cannot say
 *   how much, and says so instead of returning zero.
 * - `filtered` — reached but withheld by a caller-requested filter (`owned`).
 *
 * `no-credentials` is excluded on purpose: the engine is never handed one, so
 * it can never be missing one. Two reasons are added for the predictor itself:
 *
 * - `no-engine` — no variable in the chain named an engine. Nothing is
 *   configured; this is a setup state, not a failure.
 * - `engine-unreachable` — a variable named an engine and it did not answer.
 * - `engine-out-of-credit` — the engine answered, and refused because the
 *   account behind it has no balance left (#2359).
 * - `engine-over-quota` — the engine answered, and refused because a rate or
 *   volume limit is spent (#2359).
 * - `credential-in-request` — the request itself carried something that must
 *   not leave the process, so nothing was sent. The one refusal chant raises
 *   about itself rather than about the engine; see
 *   {@link screenBehaviourRequest}.
 *
 * The last four are one axis split four ways, because each has a different
 * remedy and a refusal exists to be acted on. `no-engine` wants a variable
 * set. `engine-unreachable` wants the address checked. `engine-out-of-credit`
 * wants somebody to pay, and no amount of waiting fixes it.
 * `engine-over-quota` usually wants nothing but the window to roll over, and
 * telling somebody to top up an account that is not empty sends them to the
 * wrong place — as does folding either into `engine-unreachable`, which points
 * at an address that is answering perfectly well.
 */
export type BehaviourUnpredictedReason =
  | Exclude<UnobservedReason, "no-credentials">
  | "no-engine"
  | "engine-unreachable"
  | "engine-out-of-credit"
  | "engine-over-quota"
  | "credential-in-request";

/**
 * The total witness. This is the one that earns the construction: the type
 * above derives from `UnobservedReason`, so adding a reason to THAT union —
 * in ./observation.ts, for reasons that have nothing to do with prediction —
 * silently widens this one. With a hand-written array, the widening compiled
 * clean, every existing test stayed green, and the new reason was assignable to
 * `BehaviourUnpredictedReason` while {@link isBehaviourUnpredictedReason}
 * returned `false` for it and the conformance suite rejected it. Keyed off the
 * union, the same change fails to compile here and somebody has to decide
 * whether the new reason belongs to behaviour at all.
 */
const BEHAVIOUR_UNPREDICTED_REASON_WITNESS: Record<BehaviourUnpredictedReason, true> = {
  "read-failed": true,
  "no-binding": true,
  "unsupported-kind": true,
  filtered: true,
  "no-engine": true,
  "engine-unreachable": true,
  "engine-out-of-credit": true,
  "engine-over-quota": true,
  "credential-in-request": true,
};

/** Every legal {@link BehaviourUnpredictedReason}, for validation and conformance checks. */
export const BEHAVIOUR_UNPREDICTED_REASONS: readonly BehaviourUnpredictedReason[] = Object.keys(
  BEHAVIOUR_UNPREDICTED_REASON_WITNESS,
) as BehaviourUnpredictedReason[];

/** True when `value` is a legal {@link BehaviourUnpredictedReason}. */
export function isBehaviourUnpredictedReason(
  value: unknown,
): value is BehaviourUnpredictedReason {
  return (
    typeof value === "string" &&
    (BEHAVIOUR_UNPREDICTED_REASONS as readonly string[]).includes(value)
  );
}

/** One declared entity that got no prediction, and why. */
export interface UnpredictedEntity {
  /** Declared entity type, when the lexicon knows it (it usually does — the entity is declared). */
  type?: string;
  /** Total verdict. */
  reason: BehaviourUnpredictedReason;
  /** Human-readable detail: the kind with no model, the call that failed. */
  detail?: string;
}

/**
 * Report-level facts about a run that produced figures. Rides as
 * `meta._behaviour` on the overlay graph.
 */
export interface BehaviourReportMeta {
  /** The engine that answered for the run as a whole. */
  engine: string;
  /** Its version. */
  version: string;
  /** The traffic level the run was asked for, echoed from the request. */
  at: BehaviourTrafficLevel;
  /**
   * An estate total, when the engine states one of its own. Optional, and
   * emphatically not a field for chant or a consumer to fill in by summing —
   * a consumer that sums does its own arithmetic and labels it as such.
   */
  total?: PredictedRate;
  /**
   * The edge coverage the run was given, echoed from the request (#2360).
   *
   * Required, and it is the whole reason `edgeCoverage` is worth stating. Held
   * only on {@link PredictBehaviourOptions} it never reached a reader, so a
   * consumer holding a report could not tell whether a "survives one zone lost"
   * verdict was computed over a complete graph or over one whose builder had no
   * idea what it had missed. Under this contract's own second constraint that
   * makes the verdict a faked number the shape renders invisible — the failure
   * the refusal arm exists to prevent, reappearing one level down.
   *
   * `behaviourReport` copies it from the request, so a lexicon does not restate
   * it and cannot restate it differently.
   */
  edgeCoverage: BehaviourEdgeCoverage;
}

/**
 * A run that produced figures. The `behaviour: "v1"` discriminant is a wire
 * version for the same reason `observation: "v1"` is: consumers branch on it.
 */
export interface BehaviourReport {
  /** Discriminant + wire version. */
  readonly behaviour: "v1";
  /** Which engine ran, at what traffic level. */
  meta: BehaviourReportMeta;
  /** PREDICTED, keyed by chant entity name. */
  entities: Record<string, PredictedBehaviour>;
  /**
   * NOT-PREDICTED, keyed by chant entity name, with a total reason. Together
   * with `entities` this must cover every name the caller asked about.
   */
  unpredicted?: Record<string, UnpredictedEntity>;
}

/**
 * Why there is no report at all, and what to do about it.
 *
 * `reason` and `remedy` are the two strings a consumer prints where the legend
 * would go; `cause` and `source` are additive and switchable. The refusal is
 * the lexicon's own text in the house style, naming the variable it wanted —
 * see {@link noBehaviourEngineMessage}.
 */
export interface BehaviourRefusal {
  /** Total, switchable verdict. */
  cause: BehaviourUnpredictedReason;
  /** The sentence a consumer prints. Names what was missing. */
  reason: string;
  /** How to fix it. Names the variable and how to set it. */
  remedy: string;
  /** Which variable in the chain answered, when one did. Absent for `no-engine`. */
  source?: string;
}

/**
 * A run that produced nothing, and says why.
 *
 * A separate member of the union rather than a flag on {@link BehaviourReport},
 * so a refusal has no `entities` map to be empty and no `meta.total` to be
 * zero. "The engine is unreachable" and "the engine priced this estate at
 * nothing" are different objects, and no amount of downstream carelessness can
 * turn the first into the second.
 */
export interface BehaviourRefusalReport {
  /** Discriminant + wire version, shared with {@link BehaviourReport}. */
  readonly behaviour: "v1";
  /** The refusal. Present *instead of* every figure, never alongside one. */
  refusal: BehaviourRefusal;
}

/** What `predictBehaviour()` returns: figures, or a named refusal. Never both, never neither. */
export type BehaviourResult = BehaviourReport | BehaviourRefusalReport;

/** True when the lexicon refused rather than predicting. */
export function isBehaviourRefusalReport(
  value: BehaviourResult,
): value is BehaviourRefusalReport {
  return typeof value === "object" && value !== null && "refusal" in value;
}

/**
 * True when `value` is either arm of the versioned {@link BehaviourResult}
 * envelope.
 *
 * Both the discriminant AND an arm, because the discriminant alone is not the
 * type. `{ behaviour: "v1" }` carries the version and is neither arm: it fails
 * {@link isBehaviourRefusalReport}, so a consumer's `if (refusal) … else …`
 * narrows it to {@link BehaviourReport}, and `result.entities` is `undefined`
 * at a site TypeScript has been told cannot be.
 */
export function isBehaviourResult(value: unknown): value is BehaviourResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { behaviour?: unknown; refusal?: unknown; entities?: unknown; meta?: unknown };
  if (v.behaviour !== "v1") return false;
  if (typeof v.refusal === "object" && v.refusal !== null) return true;
  return (
    typeof v.entities === "object" && v.entities !== null && typeof v.meta === "object" && v.meta !== null
  );
}

/**
 * Words that state nothing. Rejected wherever this contract asks an engine to
 * *state* something — its tolerance, and the failure a verdict is about.
 *
 * `"none"` as a `resilience.failure` was the hole: the module's own doc says a
 * verdict with no named failure says nothing, and `"none"` names no failure
 * while sailing through a non-empty-string check.
 */
const STATES_NOTHING: readonly string[] = ["n/a", "na", "none", "unknown", "-", "?", "tbd", "null"];

/** True when a stated value is one of the words that state nothing. */
function statesNothing(value: string): boolean {
  return STATES_NOTHING.includes(value.trim().toLowerCase().replace(/\.$/, ""));
}

const isFraction = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isFilled = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/**
 * Every rule behold's `validateBehaviourBlock` applies, applied here instead —
 * before the block is built rather than after it has travelled.
 *
 * The rule set is deliberately, literally the same set. behold
 * (`behold/src/behaviour.ts:209`) validates each block on arrival and **drops
 * the whole block** with a diagnostic when one fails, so a block chant's types
 * accept and behold's validator rejects renders nothing at all, having looked
 * perfectly legal every step of the way here. Types cannot carry most of these:
 * `tolerance: string` accepts `""`, `errorRate: number` accepts `1.2`, and
 * `cost.perHour: number` accepts `-4`.
 *
 * The mapping, by behold's own numbering, so a future change there has a named
 * place to land here:
 *
 *  2 `at.traffic` non-empty · 3 `cost.perHour` finite · 4 not negative ·
 *  5 `cost.currency` non-empty · 6 `headroom` present · 7/8 each axis a
 *  fraction · 9 at least one axis · 10 `errorRate` a fraction ·
 *  11 `resilience.failure` non-empty · 12 verdict in the closed set ·
 *  13 `rightSize` implies a `suggestion` · 14 `provenance.engine` non-empty ·
 *  15 `version` non-empty · 16 `tolerance` non-empty · 17 `basis` in the closed
 *  set.
 *
 * Rules 9 and 16 are the two chant is stricter on. Rule 9 is also a type here
 * ({@link BehaviourHeadroom} is a union requiring one axis), so this is the
 * backstop for a JavaScript caller. And on 16, behold accepts any non-empty
 * string while this rejects `n/a`, `none`, `unknown` and friends: the epic asks
 * for the engine's *stated* tolerance, and a word meaning "I have none to
 * state" passes behold's check while defeating its purpose.
 */
export function validateBehaviourBlock(name: string, block: PredictedBehaviour): void {
  const bad = (why: string): never => {
    throw new Error(
      `predictBehaviour produced an invalid block for "${name}": ${why}. behold's own validator ` +
        "(behold/src/behaviour.ts) drops a block failing this, so it would render nothing rather than " +
        "render wrong — which is worse to debug, because everything here looked legal.",
    );
  };

  if (!isFilled(block.at?.traffic)) bad("at.traffic is missing — name the traffic level you priced");

  const perHour = block.cost?.perHour;
  if (typeof perHour !== "number" || !Number.isFinite(perHour)) bad("cost.perHour is not a finite number");
  if ((perHour as number) < 0) bad("cost.perHour is negative");
  if (!isFilled(block.cost?.currency)) bad("cost.currency is missing");

  const headroom = block.headroom as { cpu?: unknown; latency?: unknown } | undefined;
  if (!headroom || typeof headroom !== "object") bad("headroom is missing");
  const h = headroom as { cpu?: unknown; latency?: unknown };
  if (h.cpu !== undefined && !isFraction(h.cpu)) bad("headroom.cpu is not a fraction 0..1");
  if (h.latency !== undefined && !isFraction(h.latency)) bad("headroom.latency is not a fraction 0..1");
  if (h.cpu === undefined && h.latency === undefined) {
    bad("headroom carries neither cpu nor latency — an axis you did not model is absent, and a block with no axis at all says nothing");
  }

  if (!isFraction(block.errorRate)) bad("errorRate is not a fraction 0..1");

  if (!isFilled(block.resilience?.failure)) {
    bad("resilience.failure is missing — a verdict with no named failure says nothing");
  }
  if (statesNothing(block.resilience.failure)) {
    bad(
      `resilience.failure ${JSON.stringify(block.resilience.failure)} names no failure. behold takes ` +
        "any non-empty string here, so this passes its validator and renders a confident verdict about " +
        'nothing. Name the event: "one zone lost", "primary database failover"',
    );
  }
  if (!isResilienceVerdict(block.resilience?.verdict)) {
    bad(`resilience.verdict ${JSON.stringify(block.resilience?.verdict)} is not survives/degrades/fails`);
  }

  if (block.rightSize !== undefined && !isFilled(block.rightSize.suggestion)) {
    bad("rightSize is present without a suggestion");
  }

  const p = block.provenance;
  if (!p || typeof p !== "object") bad("provenance is missing");
  if (!isFilled(p?.engine)) bad("provenance.engine is missing");
  if (!isFilled(p?.version)) bad("provenance.version is missing");
  if (!isFilled(p?.tolerance)) {
    bad("provenance.tolerance is missing — a figure without a stated tolerance is not a prediction");
  }
  if (statesNothing(p.tolerance)) {
    bad(
      `provenance.tolerance ${JSON.stringify(p.tolerance)} states no tolerance. An engine with nothing ` +
        "to say about its own error bars has no business publishing a figure; say the number, however wide",
    );
  }
  if (!isBehaviourBasis(p?.basis)) {
    bad(`provenance.basis ${JSON.stringify(p?.basis)} is not modeled/validated`);
  }
}

/** What a lexicon states about the run itself. Everything else in the meta is copied from the request. */
export interface BehaviourEngineStamp {
  engine: string;
  version: string;
  /** An estate total, when the engine states one of its own. Never chant's sum. */
  total?: PredictedRate;
}

/**
 * Build a {@link BehaviourReport}, and refuse to build an invalid one.
 *
 * Takes the request rather than a hand-assembled meta, and derives `at`,
 * `edgeCoverage` and the asked-for names from it. A lexicon states only what is
 * genuinely its own — which engine answered, at what version, and a total if
 * the engine has one — so the three fields that must agree with the request
 * cannot be restated differently.
 *
 * That is a check and not a proof, and the distinction matters enough to say
 * plainly: {@link BehaviourReport} is a plain interface, {@link isBehaviourResult}
 * accepts a hand-built one, and a lexicon calling this with
 * `entityNames: Object.keys(entities)` self-certifies. What passing the request
 * buys is that the ordinary route is checked and the check names what is wrong;
 * a consumer that needs the guarantee runs its own
 * `validateBehaviourResult(result, askedFor)` on arrival, which is #2358's and
 * #2360's to write.
 *
 * Refusals, all naming what went wrong:
 *
 *  - an entity in neither map — the tri-state's whole point, and the one a
 *    `continue` in a lexicon's loop produces silently;
 *  - an entity in both maps — priced and unpriced at once;
 *  - a figure for something nobody asked about;
 *  - a block priced at a level the run did not ask for;
 *  - an edge-coverage claim that names no gap ({@link validateEdgeCoverage});
 *  - any block failing {@link validateBehaviourBlock}.
 */
export function behaviourReport(
  request: Pick<PredictBehaviourOptions, "entityNames" | "traffic" | "edgeCoverage">,
  stamp: BehaviourEngineStamp,
  entities: Record<string, PredictedBehaviour>,
  unpredicted?: Record<string, UnpredictedEntity>,
): BehaviourReport {
  if (!isFilled(stamp?.engine)) throw new Error("predictBehaviour: meta.engine is missing");
  if (!isFilled(stamp?.version)) throw new Error("predictBehaviour: meta.version is missing");
  if (!isFilled(request?.traffic)) throw new Error("predictBehaviour: meta.at.traffic is missing");
  if (stamp.total && (!Number.isFinite(stamp.total.perHour) || stamp.total.perHour < 0)) {
    throw new Error("predictBehaviour: meta.total.perHour is not a non-negative finite number");
  }
  validateEdgeCoverage(request.edgeCoverage);

  const meta: BehaviourReportMeta = {
    engine: stamp.engine,
    version: stamp.version,
    at: { traffic: request.traffic },
    ...(stamp.total ? { total: stamp.total } : {}),
    edgeCoverage: request.edgeCoverage,
  };
  const entityNames = request.entityNames;
  const asked = new Set(entityNames);
  const holes = new Set(Object.keys(unpredicted ?? {}));

  for (const name of Object.keys(entities)) {
    if (holes.has(name)) {
      throw new Error(
        `predictBehaviour reported "${name}" as both priced and unpriced. An entity has one verdict.`,
      );
    }
    if (!asked.has(name)) {
      throw new Error(
        `predictBehaviour returned a figure for "${name}", which was not in entityNames. An engine ` +
          "answering about entities nobody asked about is answering about the wrong estate.",
      );
    }
    validateBehaviourBlock(name, entities[name]);
    if (entities[name].at.traffic !== meta.at.traffic) {
      throw new Error(
        `predictBehaviour priced "${name}" at ${JSON.stringify(entities[name].at.traffic)} in a run ` +
          `whose meta.at.traffic is ${JSON.stringify(meta.at.traffic)}. One run, one level.`,
      );
    }
  }

  for (const name of holes) {
    if (!asked.has(name)) {
      throw new Error(`predictBehaviour reported "${name}" unpredicted, and it was not in entityNames.`);
    }
    if (!isBehaviourUnpredictedReason(unpredicted![name]?.reason)) {
      throw new Error(
        `predictBehaviour gave "${name}" the reason ` +
          `${JSON.stringify(unpredicted![name]?.reason)}, which is not one of ` +
          `${BEHAVIOUR_UNPREDICTED_REASONS.join(", ")}.`,
      );
    }
  }

  const missing = entityNames.filter(
    (name) => !Object.prototype.hasOwnProperty.call(entities, name) && !holes.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `predictBehaviour gave no verdict at all for ${missing.map((n) => `"${n}"`).join(", ")}. Every ` +
        "entity asked about lands in `entities` or in `unpredicted` — there is no third position, " +
        "because a prediction has no equivalent of \"the provider says it is not there\". An entity " +
        "you could not price is `unsupported-kind`, not an omission.",
    );
  }

  return {
    behaviour: "v1",
    meta,
    entities,
    ...(unpredicted && Object.keys(unpredicted).length > 0 ? { unpredicted } : {}),
  };
}

/** Build a {@link BehaviourRefusalReport}. */
export function behaviourRefusal(refusal: BehaviourRefusal): BehaviourRefusalReport {
  return { behaviour: "v1", refusal };
}

/* -------------------------------------------------------------------------- */
/* Comparing two results                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether two figures are a delta of like things.
 *
 * - `comparable` — same engine, same version, same tolerance, same basis. The
 *   difference between the two numbers is a difference in the estate.
 * - `mixed-basis` — same engine and version, one figure `modeled` off list
 *   prices and the other `validated` against a bill. Subtracting these does
 *   not measure a change in the estate; part of the difference is the
 *   difference between a price list and an invoice.
 * - `mixed-engine` — the engine, its version or its stated tolerance differs.
 *   Two models are not one scale, and a delta across them is arithmetic on
 *   numbers that were never on the same axis.
 */
export type ProvenanceComparability = "comparable" | "mixed-basis" | "mixed-engine";

/**
 * Classify a pair of *provenances*. Almost always the wrong function to call —
 * see {@link compareFigures}, which is the one consumers want.
 *
 * The limit is structural rather than an oversight: `at` lives on
 * {@link PredictedBehaviour} and not on {@link BehaviourProvenance}, so this
 * function cannot see the traffic level and will happily answer `comparable`
 * for a figure at 100 rps and a figure at 1000 rps. Two predictions of the same
 * estate by the same engine at different levels are not a delta of like things;
 * they are answers to different questions. Use this only where the two figures
 * are already known to share a level.
 */
export function compareProvenance(
  a: BehaviourProvenance,
  b: BehaviourProvenance,
): ProvenanceComparability {
  if (a.engine !== b.engine || a.version !== b.version || a.tolerance !== b.tolerance) {
    return "mixed-engine";
  }
  return a.basis === b.basis ? "comparable" : "mixed-basis";
}

/** One axis on which two figures fail to be a delta of like things. */
export type FigureMismatch =
  | "mixed-engine"
  | "mixed-level"
  | "mixed-basis"
  | "mixed-currency"
  | "mixed-failure";

/**
 * Every mismatch, in the order a consumer should show them — most fundamental
 * first. Order is presentation; membership is the contract.
 */
export const FIGURE_MISMATCHES: readonly FigureMismatch[] = [
  "mixed-engine",
  "mixed-level",
  "mixed-currency",
  "mixed-basis",
  "mixed-failure",
];

/**
 * Classify a pair of figures for delta purposes. **This is the one to call.**
 *
 * Returns **every** axis on which the two disagree, not the first. An earlier
 * version returned one label and stopped at the first mismatch, which meant a
 * pair differing in level AND basis reported `mixed-level` and dropped the
 * basis crossing on the floor — a consumer told "different traffic level" would
 * caption it as such and show a modeled-minus-validated difference underneath
 * with nothing said. Precedence is a fine way to decide what to show first and
 * a bad way to decide what to know.
 *
 * The axes:
 *
 *  - `mixed-engine` — engine, version or tolerance differs. Two models are not
 *    one scale.
 *  - `mixed-level` — different `at`. The same question asked of two different
 *    worlds.
 *  - `mixed-currency` — different `cost.currency`. chant converts nothing, so
 *    USD minus EUR is not a number. behold already refuses to *sum* these
 *    (`behold/src/behaviour.ts`); permitting them to be *differenced* left this
 *    contract laxer than its own consumer.
 *  - `mixed-basis` — one figure off a price list, the other off an invoice.
 *  - `mixed-failure` — different `resilience.failure`. "Survives one zone lost"
 *    against "survives a region lost" are two verdicts about two events, and
 *    differencing the costs beside them implies they answer the same question.
 *
 * The rule this contract binds its consumers to, in one sentence: **a delta
 * between two figures whose mismatch set is not empty must be marked as such
 * wherever it is shown, and must never be presented as a plain difference.**
 * How it is marked is #2358's to choose. Whether it must be marked is not.
 */
export function compareFigures(
  a: PredictedBehaviour,
  b: PredictedBehaviour,
): ReadonlySet<FigureMismatch> {
  const out = new Set<FigureMismatch>();
  if (compareProvenance(a.provenance, b.provenance) === "mixed-engine") out.add("mixed-engine");
  if (a.at.traffic !== b.at.traffic) out.add("mixed-level");
  if (a.cost.currency !== b.cost.currency) out.add("mixed-currency");
  if (a.provenance.basis !== b.provenance.basis) out.add("mixed-basis");
  if (a.resilience.failure !== b.resilience.failure) out.add("mixed-failure");
  return out;
}

/** The mismatches, ordered for display. A convenience over {@link compareFigures}. */
export function figureMismatches(a: PredictedBehaviour, b: PredictedBehaviour): FigureMismatch[] {
  const found = compareFigures(a, b);
  return FIGURE_MISMATCHES.filter((m) => found.has(m));
}

/** True when two whole figures may be shown as a plain difference, with no mark. */
export function isComparableFigure(a: PredictedBehaviour, b: PredictedBehaviour): boolean {
  return compareFigures(a, b).size === 0;
}

/** True when two provenances may be shown as a plain difference. Level-blind — see {@link compareProvenance}. */
export function isComparableProvenance(a: BehaviourProvenance, b: BehaviourProvenance): boolean {
  return compareProvenance(a, b) === "comparable";
}

/* -------------------------------------------------------------------------- */
/* Resolving an engine, and refusing when there is none                       */
/* -------------------------------------------------------------------------- */

/**
 * The engine a lexicon predicts against, and the variable that named it.
 *
 * `value` is an address — a URL, a socket path, a command on `PATH`. It is
 * **not** a credential and this contract has no channel for one; see
 * {@link PredictBehaviourOptions}. An engine that demands authentication is out
 * of scope for the plugin surface, and a lexicon that needs one must reach it
 * on its own transport without routing it through here.
 */
export interface BehaviourEngineEndpoint {
  /** The address the lexicon will predict against. */
  value: string;
  /** The variable it came from, so a refusal or a log line can name it. */
  source: string;
}

/**
 * The variables that can name a behaviour engine, most specific first. Exported
 * so a refusal message and a test can agree on the chain without restating it.
 *
 * `lexicon` scopes the first entry, which is what lets an estate priced by two
 * engines point each lexicon at its own without a per-call flag.
 */
export function behaviourEngineVariables(lexicon: string): string[] {
  const scope = lexicon.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return [`CHANT_BEHAVIOUR_ENGINE_${scope}`, "CHANT_BEHAVIOUR_ENGINE", "BEHAVIOUR_ENGINE"];
}

/**
 * Resolve the engine one lexicon predicts against, most specific first. Pure —
 * exported for testing.
 *
 * The chain is lexicon-scoped, then chant-scoped, then bare, for the same
 * reason `gitlabNoteTokenFrom` reads `CHANT_GITLAB_TOKEN` before `GITLAB_TOKEN`
 * (`./op/activities/reconcile.ts`): the narrower name exists so a project that
 * has to differ can differ, and the wider one exists so a project that does not
 * need to sets one variable.
 *
 * Returns `undefined` when nothing in the chain answered. That is `no-engine`,
 * and the caller turns it into {@link noBehaviourEngineMessage} — never into an
 * empty report.
 */
export function behaviourEngineFrom(
  lexicon: string,
  env: Record<string, string | undefined>,
): BehaviourEngineEndpoint | undefined {
  for (const source of behaviourEngineVariables(lexicon)) {
    const value = env[source]?.trim();
    if (value) return { value, source };
  }
  return undefined;
}

/** What a lexicon says when no variable in the chain names an engine. */
export function noBehaviourEngineMessage(lexicon: string): string {
  const [scoped, chantWide, bare] = behaviourEngineVariables(lexicon);
  return (
    `predictBehaviour has the ${lexicon} estate to predict and no engine to predict it with. Set a ` +
    `${chantWide} environment variable to the engine's address — a URL, a socket path, or a command on ` +
    `PATH — or ${bare} where nothing else in the environment is chant's. ${scoped} is read first, for an ` +
    "estate whose lexicons are priced by different engines. The address is not a credential: the engine " +
    "is never handed one and never writes."
  );
}

/** What a lexicon says when a variable named an engine and the engine did not answer. */
export function unreachableBehaviourEngineMessage(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  detail: string,
): string {
  return (
    `predictBehaviour reached for the ${lexicon} behaviour engine at ${redactEngineAddress(endpoint.value)}, ` +
    `named by ${endpoint.source}, and it did not answer: ${scrubEngineDetail(detail)}. No overlay is drawn and no figure is ` +
    `guessed locally. Check the engine is up and that ${endpoint.source} names the address this ` +
    "environment can reach."
  );
}

/**
 * The refusal for an estate with no engine configured. The whole of the
 * `no-engine` path, so no lexicon has to assemble one by hand.
 */
export function noBehaviourEngineRefusal(lexicon: string): BehaviourRefusalReport {
  const [, chantWide] = behaviourEngineVariables(lexicon);
  return behaviourRefusal({
    cause: "no-engine",
    reason: noBehaviourEngineMessage(lexicon),
    remedy: `Set ${chantWide} to the engine's address.`,
  });
}

/** The refusal for a configured engine that did not answer. */
export function unreachableBehaviourEngineRefusal(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  detail: string,
): BehaviourRefusalReport {
  return behaviourRefusal({
    cause: "engine-unreachable",
    reason: unreachableBehaviourEngineMessage(lexicon, endpoint, detail),
    remedy: `Check the engine at ${redactEngineAddress(endpoint.value)} is reachable, or repoint ${endpoint.source}.`,
    source: endpoint.source,
  });
}

/**
 * What a lexicon says when the engine answered and refused for want of money
 * (#2359). Distinct from unreachable on purpose: the address is fine, the
 * request arrived, and telling somebody to check their networking wastes the
 * one thing a refusal is for.
 */
export function outOfCreditBehaviourEngineMessage(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  detail: string,
): string {
  return (
    `The ${lexicon} behaviour engine at ${redactEngineAddress(endpoint.value)}, named by ${endpoint.source}, ` +
    `answered and refused: the account behind it is out of credit (${scrubEngineDetail(detail)}). The address is reachable and nothing ` +
    "here is a networking problem. Add credit to the account this engine bills, or point " +
    `${endpoint.source} at an engine on an account that has some. No overlay is drawn and no figure is ` +
    "guessed locally."
  );
}

/** What a lexicon says when the engine answered and refused for a spent limit (#2359). */
export function overQuotaBehaviourEngineMessage(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  detail: string,
): string {
  return (
    `The ${lexicon} behaviour engine at ${redactEngineAddress(endpoint.value)}, named by ${endpoint.source}, ` +
    `answered and refused: a rate or volume limit is spent (${scrubEngineDetail(detail)}). The account has credit and the address is ` +
    "reachable, so this usually clears when the engine's window rolls over. Wait for it, raise the limit " +
    `on the account, or point ${endpoint.source} at an engine with its own budget. No overlay is drawn ` +
    "and no figure is guessed locally."
  );
}

/** The refusal for an engine that answered and said the account has no balance (#2359). */
export function outOfCreditBehaviourEngineRefusal(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  detail: string,
): BehaviourRefusalReport {
  return behaviourRefusal({
    cause: "engine-out-of-credit",
    reason: outOfCreditBehaviourEngineMessage(lexicon, endpoint, detail),
    remedy: `Add credit to the account behind ${endpoint.source}, or repoint it at a funded engine.`,
    source: endpoint.source,
  });
}

/** The refusal for an engine that answered and said a limit is spent (#2359). */
export function overQuotaBehaviourEngineRefusal(
  lexicon: string,
  endpoint: BehaviourEngineEndpoint,
  detail: string,
): BehaviourRefusalReport {
  return behaviourRefusal({
    cause: "engine-over-quota",
    reason: overQuotaBehaviourEngineMessage(lexicon, endpoint, detail),
    remedy: `Wait for the engine's window to roll over, or raise the limit on the account behind ${endpoint.source}.`,
    source: endpoint.source,
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/**
 * Render a refusal for a terminal, in red.
 *
 * Red rather than the amber a degradation gets, because a missing engine is not
 * a partial answer: every behaviour-derived figure and colour is gone, and the
 * one thing the reader must not do is assume the numbers are merely late.
 *
 * `color` defaults to the same rule the rest of the CLI uses (`NO_COLOR`, and a
 * TTY on stdout); pass it explicitly where the output is asserted on.
 */
export function renderBehaviourRefusal(
  refusal: BehaviourRefusal,
  options: { color?: boolean } = {},
): string {
  const color = options.color ?? (!process.env.NO_COLOR && process.stdout.isTTY !== false);
  const body = `behaviour: refused (${refusal.cause}) — ${refusal.reason}\n  ${refusal.remedy}`;
  return color ? `${RED}${body}${RESET}` : body;
}

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Names this contract refuses to carry, each declared `?: never` on
 * {@link PredictBehaviourOptions} so the deliberate attempt is a compile error.
 *
 * This list is the *narrow* half of the guard and never the whole of it. A
 * denylist of names cannot enforce "the engine never sees a credential" — the
 * same argument that made `?: never` better than omission applies to every name
 * the list omits, and `xApiKey`, `pat` and `Authorization` with a capital A all
 * sailed past an earlier version of this file. What actually enforces the rule
 * is {@link assertNoCredentialInOptions}, which walks values.
 */
export const CREDENTIAL_OPTION_KEYS: readonly string[] = [
  "token",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "password",
  "apiKey",
  "accessKey",
  "secretKey",
  "sessionToken",
  "auth",
  "authorization",
  "bearer",
  "privateKey",
];

/**
 * Key names that are credential-shaped on their own but not as a substring —
 * the two `CREDENTIAL_ENV_NAME` (./identity.ts) does not cover.
 */
const EXTRA_CREDENTIAL_KEYS: readonly string[] = ["pat", "cookie"];

/**
 * Shortest string worth suspecting. Borrowed from `identity.ts`'s
 * `MIN_CREDENTIAL_LENGTH`, and for the same reason: below it, a "secret" is a
 * false positive.
 */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * Key suffixes that name a **reference to** a credential rather than a
 * credential, and the handful of whole names that do the same.
 *
 * This is the correction that made the guard usable. Run over every distinct
 * property key in this repo's own generated schemas, a bare substring match on
 * `SECRET|TOKEN|PASSWORD|AUTH` refused 406 aws keys, 173 azure, 89 gcp and 7
 * k8s — `imagePullSecrets`, `secretName`, `secretKeyRef` (all three are
 * references to a Secret *by name*), `ClientToken` (an idempotency nonce on
 * dozens of AWS resources), `CertificateAuthorityArn`, `authorizedNetworks`,
 * `passwordPolicy`, `authMode`, `oauthScopes`. A `tags: { author: "…" }` was
 * refused because `author` contains `auth`.
 *
 * None of those hold secret material, and every one of them is ordinary in real
 * infrastructure, which #2357, #2359 and #2360 all assemble their requests from.
 */
const REFERENCE_KEY_SUFFIXES: readonly string[] = [
  "ref",
  "refs",
  "name",
  "names",
  "id",
  "ids",
  "arn",
  "arns",
  "count",
  "validity",
  "mode",
  "modes",
  "policy",
  "policies",
  "scope",
  "scopes",
  "network",
  "networks",
  "type",
  "types",
  "enabled",
  "required",
  "version",
  "uri",
  "url",
  "urls",
  "config",
  "configs",
  "settings",
  "options",
];

/** Whole key names that are never credential material, whatever they contain. */
const REFERENCE_KEY_NAMES: readonly string[] = [
  "imagepullsecrets",
  "clienttoken",
  // A Kubernetes boolean: "mount the service account's token into this pod".
  // It holds no token and never did.
  "automountserviceaccounttoken",
  "author",
  "authors",
  "authority",
  "secretsmanager",
];

/**
 * `CREDENTIAL_ENV_NAME` with its underscores removed, derived from the same
 * source so the two cannot drift.
 *
 * That pattern was written for environment variables, where the convention is
 * `AWS_SECRET_ACCESS_KEY`, so several of its alternatives carry an underscore:
 * `PRIVATE_KEY`, `ACCESS_KEY`, `SESSION_KEY`. Object keys are written
 * `privateKey` and `accessKey`, which match none of them. Squashing both sides
 * makes one rule cover `PRIVATE_KEY`, `privateKey`, `private-key` and
 * `privatekey`.
 */
const CREDENTIAL_ENV_NAME_SQUASHED = new RegExp(CREDENTIAL_ENV_NAME.source.replace(/_/g, ""), "i");

/**
 * True when a string carries a password in userinfo — with or without a scheme.
 *
 * The scheme-less half matters: a DSN is routinely written
 * `app:hunter2@db.internal:5432/prod`, with the driver supplying the scheme, and
 * `new URL()` will not parse that at all.
 */
function hasUrlPassword(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      if (new URL(value).password !== "") return true;
    } catch {
      /* fall through to the scheme-less test */
    }
  }
  // `user:pass@host` with no scheme. Both halves non-empty, no whitespace, and
  // a host that looks like a host, so `mailto`-ish text and prose do not match.
  return /^[^\s:@/]+:[^\s:@/]+@[A-Za-z0-9._-]+(?::\d+)?(?:[/?#]|$)/.test(value.trim());
}

/**
 * True when a key name is credential-shaped, whatever its casing or separators.
 *
 * Reuses `CREDENTIAL_ENV_NAME`, which is a case-insensitive substring match over
 * `SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|APIKEY|API_KEY|ACCESS_KEY|SESSION_KEY|AUTH`.
 * That one expression covers `Authorization`, `xApiKey`, `clientSecret`,
 * `refreshToken`, `awsSecretAccessKey` and `x-api-key` — every name an earlier
 * fixed 14-entry list here missed — because it is chant's existing answer to
 * the same question and had already been widened by everyone who hit a gap.
 */
function isCredentialKey(key: string): boolean {
  const squashed = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (REFERENCE_KEY_NAMES.includes(squashed)) return false;
  if (REFERENCE_KEY_SUFFIXES.some((s) => squashed.endsWith(s))) return false;
  if (EXTRA_CREDENTIAL_KEYS.includes(squashed)) return true;
  return CREDENTIAL_ENV_NAME.test(key) || CREDENTIAL_ENV_NAME_SQUASHED.test(squashed);
}

/**
 * True when a string is evidently a *pointer to* a secret rather than one.
 *
 * `AdminPassword` on `AWS::DirectoryService::MicrosoftAD` is a genuine
 * credential field, and chant source almost always fills it with a
 * `{{resolve:secretsmanager:…}}` string or an interpolation rather than a
 * literal. Refusing those would refuse the correct way to write it.
 */
function looksLikeSecretReference(value: string): boolean {
  return (
    /^\{\{[^}]+\}\}$/.test(value.trim()) ||
    /^\$\{[^}]+\}$/.test(value.trim()) ||
    /^!(?:Ref|GetAtt|Sub|ImportValue)\b/.test(value.trim()) ||
    /^arn:[a-z0-9-]*:secretsmanager:/i.test(value.trim()) ||
    /^projects\/[^/]+\/secrets\/[^/]+/.test(value.trim())
  );
}

/**
 * What a credential-shaped value is, or `undefined`. Named so a refusal can say
 * which rule fired rather than "something looked wrong".
 */
function credentialValueShape(value: string): string | undefined {
  for (const re of CREDENTIAL_SHAPES) {
    re.lastIndex = 0;
    if (re.test(value)) return "a literal credential shape (PEM key, JWT or Authorization value)";
  }
  for (const { name, re } of CREDENTIAL_TOKEN_SHAPES) {
    re.lastIndex = 0;
    if (re.test(value)) return name;
  }
  if (hasUrlPassword(value)) return "a password in a URL's userinfo";
  return undefined;
}

/** A URL-ish string with its userinfo blanked and its query dropped. */
function stripUrlSecrets(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const hadUserinfo = url.username !== "" || url.password !== "";
    const hadQuery = url.search !== "";
    // The fragment too. OAuth's implicit flow puts the access token there
    // (`#access_token=…`), it never reaches a server, and it was untouched.
    const hadFragment = url.hash !== "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    // Markers are appended AFTER `toString()` and in wire order — query then
    // fragment. Appending the query marker to a string that still carried a
    // fragment used to land it inside the fragment.
    let out = url.toString();
    if (hadUserinfo) out = out.replace("://", `://${REDACTED}@`);
    if (hadQuery) out += `?${REDACTED}`;
    if (hadFragment) out += `#${REDACTED}`;
    return out;
  } catch {
    return value;
  }
}

/**
 * Blank the value of an inline command-line flag: `--token=x`, `-p x`,
 * `--api-key x`. A behaviour engine may be a command on `PATH`, and a command
 * carries its credential as an argument rather than in a URL, so the URL parse
 * has nothing to bite on and `redactCredentialMaterial` — which knows env
 * values and ten token prefixes — sees an inline flag value as neither.
 */
function stripFlagSecrets(value: string): string {
  return value
    .replace(
      /(--?[A-Za-z0-9-]*(?:secret|token|password|passwd|key|credential|auth|pat)[A-Za-z0-9-]*)([=\s])(\S+)/gi,
      (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`,
    )
    .replace(/(^|\s)(-[pPkK])(\s+)(\S+)/g, (_m, lead: string, flag: string, sp: string) => `${lead}${flag}${sp}${REDACTED}`);
}

/**
 * An engine address, safe to interpolate into a refusal that a merge-request
 * comment will carry (#2358).
 *
 * `CHANT_BEHAVIOUR_ENGINE=https://svc:s3cr3t@engine.internal/predict?key=abc` is
 * an ordinary way to point at an authenticated endpoint, and it is the shape
 * this contract's own "resolve auth on your own transport" guidance produces.
 * Printing it verbatim in a refusal publishes it.
 *
 * Three passes, in order:
 *
 *  1. The URL parse blanks `username`/`password`, and drops the query string and
 *     the fragment **whole** rather than by known parameter name — `?key=`,
 *     `?token=`, `?sig=` and `#access_token=` are all common and the set is not
 *     enumerable. The fragment matters on its own account: OAuth's implicit
 *     flow puts the access token there.
 *  2. Inline command-line flag values (`--token=…`, `-p …`), for an engine that
 *     is a command on `PATH` rather than a URL.
 *  3. {@link redactCredentialMaterial}, for env-held values and the token
 *     shapes chant knows.
 *
 * **What survives:** a credential written as a bare path segment
 * (`https://host/predict/<token>/go`) unless it matches a known token shape.
 * Nothing here can tell that segment from a resource id, and an earlier version
 * of this doc claimed pass 3 caught it, which was wrong. If an engine
 * authenticates by path, do not put its address in a variable whose refusal
 * text is published.
 */
export function redactEngineAddress(
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return redactCredentialMaterial(stripFlagSecrets(stripUrlSecrets(value)), env);
}

/**
 * Engine-supplied detail, bounded and scrubbed before it reaches a refusal.
 *
 * `detail` on a credit or quota refusal is whatever the engine said, echoed.
 * An engine is a third party: it can be verbose, and it can quote the request
 * back at you, which is how a URL or an id ends up in a public comment. So the
 * text is truncated, anything URL-shaped is reduced to its host, and the result
 * goes through {@link redactCredentialMaterial}.
 */
export function scrubEngineDetail(
  detail: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const withoutUrls = detail.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (match) => {
    try {
      return new URL(match).host || REDACTED;
    } catch {
      return REDACTED;
    }
  });
  const scrubbed = redactCredentialMaterial(withoutUrls, env).replace(/\s+/g, " ").trim();
  return scrubbed.length > MAX_ENGINE_DETAIL ? `${scrubbed.slice(0, MAX_ENGINE_DETAIL)}…` : scrubbed;
}

/** How much engine-supplied text a refusal will repeat. */
const MAX_ENGINE_DETAIL = 200;

/**
 * How complete a request's edge list is (#2360).
 *
 * - `complete` — every reference between the named entities is in `edges`.
 *   Only claim this when the builder knows it: a declared-path build walking
 *   resolved `AttrRef`s does, a live rebuild over a partial catalog does not.
 * - `partial` — some references are known to be missing, and `dangling` or
 *   `unresolvedKinds` says which. An engine may still answer, and should
 *   discount its own confidence.
 * - `unknown` — the builder cannot say. Treat like `partial` and trust nothing
 *   that depends on reachability.
 */
export type EdgeCoverageVerdict = "complete" | "partial" | "unknown";

const EDGE_COVERAGE_WITNESS: Record<EdgeCoverageVerdict, true> = {
  complete: true,
  partial: true,
  unknown: true,
};

/** Every legal {@link EdgeCoverageVerdict}. */
export const EDGE_COVERAGE_VERDICTS: readonly EdgeCoverageVerdict[] = Object.keys(
  EDGE_COVERAGE_WITNESS,
) as EdgeCoverageVerdict[];

/** True when `value` is a legal {@link EdgeCoverageVerdict}. */
export function isEdgeCoverageVerdict(value: unknown): value is EdgeCoverageVerdict {
  return typeof value === "string" && (EDGE_COVERAGE_VERDICTS as readonly string[]).includes(value);
}

/**
 * What a caller knows about the completeness of the graph it is handing over.
 *
 * Note on `complete` with a non-empty {@link dangling}: that is **not** a
 * contradiction and must not be "fixed". A dangling reference points at
 * something outside the named entity set by definition — a cross-account VPC, a
 * resource another team owns — so a builder can have found every edge among the
 * entities it was asked about and still have references leaving the estate.
 * `complete` is a claim about the edges *between the named entities*.
 */
export interface BehaviourEdgeCoverage {
  verdict: EdgeCoverageVerdict;
  /**
   * References that resolved to no entity in this request — the `dangling` list
   * `reconstructEdges` (./graph-refs.ts) already returns and used to discard.
   *
   * `DanglingRef`, not a flattened string. The record carries `from`, and `from`
   * is the field that says *which* entity's path leaves the estate; flattening
   * to the target value alone leaves an engine knowing that something dangles
   * and not what.
   */
  dangling?: readonly DanglingRef[];
  /**
   * Entity types the builder has no reference rules for, so nothing was looked
   * for. This is the quiet one: a kind with no `RefRule` produces no edges and
   * no complaint.
   */
  unresolvedKinds?: readonly string[];
  /**
   * Containment as traversable edges — populate from
   * `reconstructEdges().containmentEdges` (./graph-refs.ts), **not** from the
   * `containment: ContainmentPair[]` field beside it. The two are the same
   * relationships in two shapes, and only the edge shape belongs here; the
   * field was called `containment` and pointed #2360 straight at the wrong one.
   *
   * Carried separately from {@link PredictBehaviourOptions.edges} because
   * `chant graph` draws containment as a boundary rather than a line, and
   * putting it in `edges` would draw a line from every resource to its VPC. An
   * engine asked whether an estate survives one zone lost needs the membership
   * and `edges` will never have it.
   */
  containmentEdges?: readonly IREdge[];
}

/**
 * Refuse an edge-coverage claim that does not say anything.
 *
 * `partial` means "some references are known to be missing", and a `partial`
 * with neither `dangling` nor `unresolvedKinds` names none of them — which is
 * `unknown` wearing a more confident word. Use `unknown` for "I cannot say";
 * `partial` is for "I can say, and here it is".
 */
export function validateEdgeCoverage(coverage: BehaviourEdgeCoverage): void {
  if (!isEdgeCoverageVerdict(coverage?.verdict)) {
    throw new Error(
      `predictBehaviour: edgeCoverage.verdict ${JSON.stringify(coverage?.verdict)} is not ` +
        `${EDGE_COVERAGE_VERDICTS.join("/")}.`,
    );
  }
  if (
    coverage.verdict === "partial" &&
    (coverage.dangling?.length ?? 0) === 0 &&
    (coverage.unresolvedKinds?.length ?? 0) === 0
  ) {
    throw new Error(
      'predictBehaviour: edgeCoverage is "partial" and names nothing missing. Populate `dangling` ' +
        'or `unresolvedKinds`, or say "unknown" — a partial that lists no gap is an unknown with a ' +
        "more confident word on it.",
    );
  }
}

/**
 * What core hands a lexicon's `predictBehaviour`.
 *
 * The first seven fields are `observeResourcesDeep`'s options, field for field
 * and doc for doc, so a caller that already drives the deep read drives this
 * with the same object plus `traffic`. That is the point of the mirror: the two
 * reads answer different questions about the same request.
 *
 * The `?: never` block is the enforcement half of "the engine never sees
 * credentials". Declaring the keys rather than omitting them buys a real check:
 * an omitted key is only caught by the excess-property check on an object
 * literal, and slips through a spread or a widened variable, while `never`
 * rejects a `string` from any position and names the field in the error.
 */
export interface PredictBehaviourOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Deployed stack to predict for, in a multi-stack project (see `stacks` in `ChantConfig`). */
  stack?: string;
  /** Region the stack is deployed in, mirroring the deep read (#1267). Omitted keeps the ambient default. */
  region?: string;
  /** Restrict to chant-owned resources (#119). An entity withheld here is `filtered`, not absent. */
  owned?: boolean;
  /**
   * The traffic level to predict at, verbatim: `100 rps, p50`. The one field
   * the deep read has no counterpart for, and the reason a prediction can never
   * be mistaken for an observation — an observation is not *at* anything.
   *
   * chant does not parse it, does not default it, and does not convert it. An
   * engine that cannot understand the level it was handed refuses; it does not
   * substitute one it likes better.
   */
  traffic: string;
  /**
   * The edges between the entities above (#2355) — the half of "a resource
   * graph" that a bag of nodes is not.
   *
   * This is the one field where the mirror of `observeResourcesDeep`'s options
   * deliberately breaks, and it breaks because the two reads want different
   * things. A deep read answers per entity and needs no neighbours: an S3
   * bucket's live property tree is the same tree whether or not a Lambda reads
   * from it. A prediction is the opposite. Headroom, an error rate and a
   * resilience verdict under "one zone lost" are all statements about a path
   * through the estate, and an engine handed nodes alone can only price each
   * box in isolation, which is the arithmetic a consumer could already do for
   * itself.
   *
   * `IREdge` (./graph-ir.ts) rather than an edge type of this contract's own,
   * for one reason that outranks the tidiness of a purpose-built shape: it is
   * already the engine-neutral edge that BOTH paths produce. `collectEdges`
   * builds them from declared `AttrRef`s and lexicon-resolved entity
   * references on the declared path, and `reconstructEdges` (./graph-refs.ts)
   * rebuilds them from observed physical identifiers on the live path, which
   * is the path #2360 assembles this request on. A second edge type here would
   * put a lossy translation hop on each side, and the epic wants the declared
   * prediction and the live prediction shown as a delta — two shapes that have
   * each been through a different translation are the worst possible input to
   * a delta. `DependencyObservation.edges` (./lexicon.ts) already carries
   * `IREdge` for the same reason.
   *
   * `from` and `to` are chant entity names, the keys {@link entityNames} and
   * {@link entities} use. An edge naming an entity outside `entityNames`
   * points outside the estate the caller asked about, and an engine may ignore
   * it.
   *
   * Required, and an empty array is a claim rather than a shrug: it says this
   * estate's entities reference nothing of each other. A caller that has not
   * computed edges must not pass `[]` and call it a graph, for the same reason
   * absence and unreadness are separate verdicts everywhere else here — which
   * is what {@link edgeCoverage} exists to let it say instead.
   */
  edges: readonly IREdge[];
  /**
   * How complete {@link edges} is, and what is known to be missing from it.
   *
   * `edges: []` cannot distinguish "nothing references anything" from "I could
   * not work out what references what", and both are ordinary outcomes on the
   * live path. `reconstructEdges` (./graph-refs.ts) returns `dangling` — the
   * references it resolved to no observed node — and drops them; a kind with no
   * `RefRule` in the lexicon's catalog contributes no edges at all and says
   * nothing about it; and containment (a subnet inside a VPC) is deliberately
   * not an edge, which means zone membership is absent from `edges` by design.
   * An engine asked "does this survive one zone lost" over a graph with no zone
   * membership answers confidently and wrongly.
   *
   * So the completeness is stated rather than assumed, and stated *now*, before
   * five consumers are written against a field that silently means "complete".
   */
  edgeCoverage: BehaviourEdgeCoverage;

  /** Not a channel. See {@link CREDENTIAL_OPTION_KEYS}. */
  token?: never;
  /** Not a channel. */
  credential?: never;
  /** Not a channel. */
  credentials?: never;
  /** Not a channel. */
  secret?: never;
  /** Not a channel. */
  secrets?: never;
  /** Not a channel. */
  password?: never;
  /** Not a channel. */
  apiKey?: never;
  /** Not a channel. */
  accessKey?: never;
  /** Not a channel. */
  secretKey?: never;
  /** Not a channel. */
  sessionToken?: never;
  /** Not a channel. */
  auth?: never;
  /** Not a channel. */
  authorization?: never;
  /** Not a channel. */
  bearer?: never;
  /** Not a channel. */
  privateKey?: never;
}

/** How deep the credential walk goes before it stops descending. */
const CREDENTIAL_WALK_DEPTH = 12;

/**
 * Refuse a request carrying anything credential-shaped, anywhere in it.
 *
 * The `?: never` fields on {@link PredictBehaviourOptions} stop the deliberate
 * attempt at compile time. This stops the accident, which is the one that
 * happens: it walks **the whole request** — including `entities[*].props`,
 * which is `Record<string, unknown>` straight out of the build and which no
 * type on this contract can see into, and every field of every
 * {@link import("./graph-ir").IREdge}.
 *
 * ## What it detects
 *
 * 1. **A credential-shaped value**, whatever the key is called: the PEM / JWT /
 *    `Bearer` shapes in `CREDENTIAL_SHAPES`, plus the provider-prefixed tokens
 *    in `CREDENTIAL_TOKEN_SHAPES` (GitHub, GitLab, OpenAI, Stripe, Slack, AWS,
 *    Google, npm).
 * 2. **A password in userinfo**, with or without a scheme — `new URL()` for the
 *    former and a pattern for `app:hunter2@db.internal:5432/prod`, which is how
 *    a DSN is usually written and which `URL` will not parse at all.
 * 3. **A credential-shaped key**, but only when its value is a string of at
 *    least {@link MIN_CREDENTIAL_LENGTH} characters that is not an evident
 *    reference, and only when the key is not in the reference family
 *    ({@link REFERENCE_KEY_SUFFIXES}).
 *
 * Rules 1 and 2 throw. Rule 3, and a structure deeper than the walk reads,
 * produce a refusal instead — see {@link screenBehaviourRequest} for why the
 * blast radii differ.
 *
 * **The name layer is a fast path, not a safety net.** After the gating above
 * it fires on very little, and a credential under a benign name — `dsn`,
 * `config`, `note` — is caught by rules 1 and 2 or not at all. That is the
 * intended division of labour and the reason those two exist; do not read
 * rule 3 as the guarantee.
 *
 * ## What it deliberately does not detect
 *
 * Rule 1 is **a denylist of known formats, not a proof**. A token from a
 * provider nobody has added, an internal issuer's format, a bare random string
 * or a base64 blob passes every rule here, as does a secret split across two
 * fields or encoded. There is no entropy scoring, on purpose: this walks build
 * output full of ids, ARNs, hashes and digests, and a heuristic that refuses
 * those would refuse real projects rather than protect them. So the honest
 * statement of the guarantee is that a credential a human would recognize on
 * sight will not reach the engine by accident, and that a novel or opaque
 * secret still can. A lexicon author putting secret material in `props` is
 * outside what this contract can catch, and the remedy there is not to.
 */
export type CredentialRule = "value-shape" | "key-name" | "walk-depth";

/** One thing the walk objected to, and which rule objected. */
export interface CredentialFinding {
  /** Where in the request, as a readable path (`options.entities.get(db).props.dsn`). */
  path: string;
  rule: CredentialRule;
  /** What was found, in words, for the message. Never the value itself. */
  what: string;
}

/**
 * Every objection the walk has to a request. Pure, and exported so a caller can
 * decide what to do rather than take this module's word for it.
 */
export function findCredentialsInOptions(options: object): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > CREDENTIAL_WALK_DEPTH) {
      // Not silence. A request deeper than the walk goes is a request this
      // guard has not actually checked, and saying nothing about it is the
      // shape of failure this whole contract exists to refuse.
      findings.push({
        path,
        rule: "walk-depth",
        what: `a structure deeper than ${CREDENTIAL_WALK_DEPTH} levels, which the credential walk did not read`,
      });
      return;
    }
    if (typeof value === "string") {
      const shape = credentialValueShape(value);
      if (shape) findings.push({ path, rule: "value-shape", what: shape });
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (value instanceof Map) {
      for (const [key, item] of value) {
        const label = typeof key === "string" ? key : String(key);
        const child = `${path}.get(${label})`;
        // Both halves. A Map's KEY is as likely to be `DB_PASSWORD` as an
        // object's is — an env block is the obvious case — and walking only
        // values missed it entirely.
        if (typeof key === "string") checkKey(key, child, item);
        walk(item, child, depth + 1);
      }
      return;
    }
    if (value instanceof Set) {
      let i = 0;
      for (const item of value) walk(item, `${path}.item[${i++}]`, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const child = `${path}.${key}`;
      checkKey(key, child, item);
      walk(item, child, depth + 1);
    }
  };

  /**
   * The name arm. Gated on the value being a string long enough to be a secret,
   * and not an evident reference to one — see {@link REFERENCE_KEY_SUFFIXES}
   * for why the ungated version was unusable.
   */
  function checkKey(key: string, path: string, item: unknown): void {
    if (typeof item !== "string") return;
    if (item.length < MIN_CREDENTIAL_LENGTH) return;
    if (looksLikeSecretReference(item)) return;
    if (!isCredentialKey(key)) return;
    findings.push({ path, rule: "key-name", what: `a credential-shaped field name ("${key}")` });
  }

  walk(options, "options", 0);
  return findings;
}

/**
 * Throw when the request carries something that **is** a credential.
 *
 * Only the value-shape rule throws, and throwing is deliberate here: a live
 * token in a request bound for a third party is not a degradation to report, it
 * is a stop. Throwing is the whole-lexicon failure per `lexicon.ts`, which is
 * the right blast radius for this and the wrong one for a suspicious field name
 * — see {@link screenBehaviourRequest}.
 */
export function assertNoCredentialInOptions(options: object): void {
  const found = findCredentialsInOptions(options).filter((f) => f.rule === "value-shape");
  if (found.length === 0) return;
  const [first] = found;
  throw new Error(
    `predictBehaviour was passed ${first.what} at ${first.path}. The behaviour engine is never handed ` +
      "a credential: it is given the resource graph and a traffic level, and nothing it receives can " +
      "reach the account. Remove it — a lexicon that needs authenticated access to its own engine " +
      "resolves that on its own transport, not through this contract.",
  );
}

/**
 * Screen a whole request. **This is what a lexicon calls.**
 *
 * Two outcomes, because two things are being caught and they deserve different
 * blast radii:
 *
 *  - a value that IS a credential throws, via
 *    {@link assertNoCredentialInOptions};
 *  - a merely suspicious field name, or a structure too deep to have been read,
 *    returns a {@link BehaviourRefusalReport} with cause
 *    `credential-in-request`. No overlay is drawn and the reason names the
 *    path, which is the contract's own answer to "no faked numbers" applied to
 *    its own guard.
 *
 * The split exists because the name arm is a heuristic and the old version
 * threw on it. One `tags: { author: "…" }` anywhere in an estate killed the
 * entire overlay with a stack trace, which is the exact failure mode constraint
 * 2 was written against.
 *
 * Returns `undefined` when the request is clean, so a lexicon reads
 * `const refusal = screenBehaviourRequest(name, options); if (refusal) return refusal;`
 */
export function screenBehaviourRequest(
  lexicon: string,
  options: object,
): BehaviourRefusalReport | undefined {
  assertNoCredentialInOptions(options);
  const findings = findCredentialsInOptions(options);
  if (findings.length === 0) return undefined;
  const [first] = findings;
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : "";
  return behaviourRefusal({
    cause: "credential-in-request",
    reason:
      `The ${lexicon} behaviour request carries ${first.what} at ${first.path}${more}, so it was not ` +
      "sent. The engine is a third party and this contract hands it the resource graph and a traffic " +
      "level only. No overlay is drawn and no figure is guessed locally.",
    remedy:
      "Remove the value from the declaration, or hold it in a secret reference the build does not " +
      "expand. If the field is a false positive, it still leaves the process in this request.",
  });
}
