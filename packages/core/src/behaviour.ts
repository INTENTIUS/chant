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
 * as money owed. Four things in this module make that a type error rather than
 * a matter of care:
 *
 *   1. Money appears in exactly one shape, {@link PredictedRate}, and that
 *      shape carries a literal `rate: "per-hour"` discriminant. There is no
 *      field anywhere for an amount, a period, an account, an invoice or a
 *      due date, so an elapsed charge is not expressible.
 *   2. A figure cannot exist without {@link PredictedBehaviour.at}, the traffic
 *      level it was predicted for. A bill is for an hour that happened; this is
 *      for an hour the engine was asked to imagine, and the type will not let
 *      the caller forget which.
 *   3. {@link BehaviourProvenance} is required on every entity, and its
 *      {@link BehaviourProvenance.basis} is a closed two-value enum: `modeled`
 *      off list prices, or `validated` against a real bill. A figure that will
 *      not say which of the two it is cannot be constructed.
 *   4. A refusal is a separate member of the {@link BehaviourResult} union with
 *      no figures on it at all, so "the engine is gone" and "the engine says
 *      zero" are different objects rather than the same object with zeroes in
 *      it.
 *
 * ## The engine sees no credential and writes nothing
 *
 * {@link PredictBehaviourOptions} mirrors `observeResourcesDeep`'s options
 * field for field — a caller already driving the deep read drives this one with
 * the same argument object plus `traffic` — and then closes the door on
 * credentials: every name a caller might reach for is declared `?: never`, so
 * passing one is a compile error, and TypeScript's excess-property check
 * rejects every other name. {@link assertNoCredentialInOptions} is the same
 * refusal for a caller arriving from JavaScript.
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
 *   - `no-engine` and `engine-unreachable` are **added**, because the epic
 *     wants a missing engine named and neither existing reason names it.
 *     `no-binding` is about the environment resolving to no target; these two
 *     are about the predictor itself, which is a different axis, and telling
 *     "nothing is configured" from "it is configured and did not answer" is the
 *     whole difference between a setup error and an outage.
 *
 * ## Shape compatibility with the overlay
 *
 * {@link PredictedBehaviour} is the object `chant graph --live --overlay` puts
 * on a node as `attrs._behaviour`, and {@link BehaviourReportMeta} /
 * {@link BehaviourRefusal} are what it puts on the graph as
 * `meta._behaviour`. behold reads those keys and does arithmetic on the
 * engine's figures; it never produces one of its own. Fields beyond what behold
 * reads (`cause`, `source` on a refusal) are additive and ignorable.
 */

import type { UnobservedReason } from "./observation";

/**
 * Whether a figure came off a price list or off a bill. Closed, and required on
 * every prediction — this is the distinction that keeps rule 1 enforceable.
 *
 * - `modeled` — computed from published list prices and the engine's own model.
 *   The honest default, and the word a badge shows unless told otherwise.
 * - `validated` — reconciled against a real invoice for a comparable estate.
 */
export type BehaviourBasis = "modeled" | "validated";

/** Every legal {@link BehaviourBasis}, for validation and conformance checks. */
export const BEHAVIOUR_BASES: readonly BehaviourBasis[] = ["modeled", "validated"];

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
export interface BehaviourHeadroom {
  /** Fraction of CPU capacity still free. */
  cpu?: number;
  /** Fraction of the latency budget still unspent. */
  latency?: number;
}

/** What an entity does when the named failure happens. Closed. */
export type ResilienceVerdict = "survives" | "degrades" | "fails";

/** Every legal {@link ResilienceVerdict}, for validation and conformance checks. */
export const RESILIENCE_VERDICTS: readonly ResilienceVerdict[] = ["survives", "degrades", "fails"];

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
 */
export type BehaviourUnpredictedReason =
  | Exclude<UnobservedReason, "no-credentials">
  | "no-engine"
  | "engine-unreachable";

/** Every legal {@link BehaviourUnpredictedReason}, for validation and conformance checks. */
export const BEHAVIOUR_UNPREDICTED_REASONS: readonly BehaviourUnpredictedReason[] = [
  "read-failed",
  "no-binding",
  "unsupported-kind",
  "filtered",
  "no-engine",
  "engine-unreachable",
];

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

/** True when `value` is either arm of the versioned {@link BehaviourResult} envelope. */
export function isBehaviourResult(value: unknown): value is BehaviourResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { behaviour?: unknown }).behaviour === "v1"
  );
}

/** Build a {@link BehaviourReport}. Lexicons use this rather than writing the discriminant by hand. */
export function behaviourReport(
  meta: BehaviourReportMeta,
  entities: Record<string, PredictedBehaviour>,
  unpredicted?: Record<string, UnpredictedEntity>,
): BehaviourReport {
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
    `predictBehaviour reached for the ${lexicon} behaviour engine at ${endpoint.value}, named by ` +
    `${endpoint.source}, and it did not answer: ${detail}. No overlay is drawn and no figure is ` +
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
    remedy: `Check the engine at ${endpoint.value} is reachable, or repoint ${endpoint.source}.`,
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
 * Names this contract refuses to carry. Every one is declared `?: never` on
 * {@link PredictBehaviourOptions}, so passing one is a compile error rather
 * than a review comment. Exported so the runtime guard and its test agree on
 * the list.
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

/**
 * The same refusal at runtime, for a caller arriving from JavaScript where the
 * `?: never` fields are only a comment. Throws naming the key, because a
 * credential that reached this boundary has already been marshalled once and
 * quietly dropping it teaches the caller nothing.
 */
export function assertNoCredentialInOptions(options: object): void {
  for (const key of CREDENTIAL_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      throw new Error(
        `predictBehaviour was passed "${key}" in its options. The behaviour engine is never handed a ` +
          "credential: it is given the resource graph and a traffic level, and nothing it receives can " +
          "reach the account. Remove the field; a lexicon that needs authenticated access to its engine " +
          "resolves it on its own transport, not through this contract.",
      );
    }
  }
}
