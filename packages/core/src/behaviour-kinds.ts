/**
 * What an engine is asked to price, and who gets to say so (#2382).
 *
 * `./behaviour.ts` says what a prediction may mean and `./behaviour-http.ts`
 * carries one to an engine. Between them sits a question neither answers: for
 * a given entity in a project's graph, what *kind* of thing is it, and is it
 * something an engine prices at all? #2357 answered it with one table in the
 * augur lexicon, keyed by every other lexicon's entity types. That table
 * described 117 types it did not own, and the capability rode on whether an
 * optional package happened to be installed — which gave a consumer a fourth
 * outcome this contract never named: no overlay, no refusal, and no reason.
 *
 * So the resolution lives here, where every other part of the feature already
 * does, and the *rows* are contributed by the lexicon that owns the substrate.
 * Core learns that an entity has an engine kind. It never learns which.
 *
 * ## Why rows are safe to make optional when the capability is not
 *
 * A lexicon that is not installed declared no entities of its types, so it has
 * no rows to contribute and nothing goes missing: the estate simply contains
 * nothing of that substrate. That is the opposite of the capability itself
 * being optional, where an uninstalled package means an estate full of
 * entities nobody will say anything about.
 *
 * ## The three things a lexicon can say about its own types
 *
 *   - **mapped** — this type is a `compute`/`database`/`queue`, and its size
 *     is read from this declared property, in the provider's own vocabulary.
 *   - **declared unmapped** — this type is real and carries no rate an engine
 *     can quote, with the sentence saying why. A grant is not a resource; a
 *     boundary is not a node; a meter chant cannot read is not a figure.
 *   - **nothing priced** — nothing this lexicon declares is an estate an
 *     engine prices, once, for the whole substrate. A CI workflow is not an
 *     estate, and a policy language has nothing to saturate.
 *
 * A type a contributor claims and has no row for is `unknown-type`: the one
 * verdict that is a defect rather than a decision, and the reason the three
 * above are distinct states instead of one absent row.
 */

/**
 * The categories a cost-and-saturation model actually distinguishes, not a
 * taxonomy of every product a cloud sells.
 *
 * A kind is here when an engine would price it differently or when its
 * saturation axis differs. `cache` is separate from `database` because a cache
 * saturates on memory and a database on IO; `serverless` is separate from
 * `compute` because one is priced per invocation and the other per hour of
 * existence, and this contract's output shape is per hour. `control-plane` is
 * separate from everything because a managed control plane is a flat hourly
 * fee that does not move with the estate's traffic at all — pricing one as
 * `compute` would make it look like something a right-size suggestion could
 * shrink.
 */
export type EngineKind =
  | "compute"
  | "serverless"
  | "control-plane"
  | "database"
  | "cache"
  | "queue"
  | "object-store"
  | "block-store"
  | "load-balancer"
  | "cdn";

const ENGINE_KIND_WITNESS: Record<EngineKind, true> = {
  compute: true,
  serverless: true,
  "control-plane": true,
  database: true,
  cache: true,
  queue: true,
  "object-store": true,
  "block-store": true,
  "load-balancer": true,
  cdn: true,
};

/**
 * Every legal {@link EngineKind}, derived from a total witness rather than
 * written out by hand — the construction `behaviour.ts` uses for
 * `BEHAVIOUR_BASES`, for the same reason: a hand-written array is checked for
 * having legal members and never for having all of them.
 */
export const ENGINE_KINDS: readonly EngineKind[] = Object.keys(ENGINE_KIND_WITNESS) as EngineKind[];

/** True when `value` is a legal {@link EngineKind}. */
export function isEngineKind(value: unknown): value is EngineKind {
  return typeof value === "string" && (ENGINE_KINDS as readonly string[]).includes(value);
}

/** One row of a lexicon's coverage: what one of its entity types becomes on the wire. */
export interface EngineKindMapping {
  /** The engine-side kind. */
  kind: EngineKind;
  /**
   * The substrate, as the engine names it — `aws`, `kubernetes`. A plain
   * string rather than a closed union: the contributing lexicon names its own
   * substrate, and core adding a member here for every lexicon that ships
   * would be core holding the list it exists to stop holding.
   */
  provider: string;
  /**
   * The declared property whose value is the entity's size, in the provider's
   * own vocabulary — `InstanceType`, not a parsed vCPU count. Absent where the
   * type has no size a single `size` string can carry.
   */
  sizeProp?: string;
  /**
   * Which type {@link sizeProp} holds. A value of the other type is absent
   * rather than coerced: a number rendered into a size field an engine matches
   * against a price table of strings is worse than no size at all.
   */
  sizeType?: "string" | "number";
  /**
   * The declared property naming the region or zone this entity sits in, where
   * the type states one of its own. Most do not, and inherit the caller's.
   */
  regionProp?: string;
}

/**
 * One lexicon's answer for its own entity types, contributed through the
 * plugin's `behaviourKinds` field.
 *
 * Every field except {@link prefixes} is optional, and a lexicon that supplies
 * only {@link nothingPriced} has said something complete: that none of what it
 * declares is an estate an engine prices.
 */
export interface BehaviourKinds {
  /** The substrate, as the engine names it. Every mapped row inherits it. */
  provider: string;
  /**
   * The entity-type prefixes this lexicon owns — `["AWS::"]`, `["K8s::"]`.
   * Ownership is what makes a missing row a defect rather than silence: a type
   * nobody claims is nobody's mistake, and a type its own lexicon claims and
   * cannot classify is a row somebody forgot to write.
   */
  prefixes: readonly string[];
  /** Types this lexicon prices, keyed by entity type — or by resolved type where {@link resolveType} is given. */
  mapped?: Readonly<Record<string, Omit<EngineKindMapping, "provider"> & { provider?: string }>>;
  /** Types that are real and carry no rate, keyed the same way, with the sentence saying why. */
  unmapped?: Readonly<Record<string, string>>;
  /**
   * Nothing this lexicon declares is priced, and this says why — checked
   * before the tables, so a lexicon that states it needs no rows at all.
   */
  nothingPriced?: string;
  /**
   * For a lexicon whose entities all share one entity type, the provider type
   * to look rows up on instead. terraform's every `resource` block arrives as
   * `Terraform::Resource`, and what an engine would price is the type its
   * address carries. Returning `undefined` is "nothing to look up", which is
   * the same no-opinion an unseen type gets.
   */
  resolveType?: (props: Record<string, unknown> | undefined) => string | undefined;
  /**
   * A last word on a type this lexicon claims and has no row for: the reason
   * it is unmapped, or `undefined` to leave it a defect. CloudFormation's
   * property types are the case this exists for — hundreds of nested blocks
   * that became entities of their own, never separately priced, and
   * enumerating them one row at a time would bury the table's real decisions.
   */
  unmappedWhen?: (type: string) => string | undefined;
}

/** What one entity type resolves to. Total: every type reaches exactly one of these. */
export type CoverageVerdict =
  | { status: "mapped"; mapping: EngineKindMapping }
  | { status: "declared-unmapped"; reason: string }
  | { status: "provider-not-modelled"; substrate: string }
  | { status: "unknown-type" };

/** chant's own build-time entities, which no lexicon owns and nothing bills. */
const CHANT_PSEUDO_PREFIX = "chant:";

/**
 * Resolve one entity type against the contributed rows.
 *
 * Total by construction: every type reaches one of the four states and there
 * is no fifth arm for "dropped". That is the property the request builder
 * relies on to guarantee every entity it was asked about lands in `entities`
 * or in `unpredicted`.
 *
 * `hasOwnProperty` rather than a truthiness check, because these are plain
 * object literals and an entity named after a prototype member would otherwise
 * resolve to a mapping that does not exist.
 */
export function coverageFor(
  contributors: readonly BehaviourKinds[],
  entityType: string,
  props?: Record<string, unknown>,
): CoverageVerdict {
  if (entityType.startsWith(CHANT_PSEUDO_PREFIX)) {
    return {
      status: "declared-unmapped",
      reason:
        "one of chant's own build-time entities rather than something an account holds — a declared " +
        "output, or a default that rides onto the resources beside it. It is never created and never " +
        "billed",
    };
  }

  const owner = contributors.find((c) => c.prefixes.some((p) => entityType.startsWith(p)));
  if (!owner) return { status: "unknown-type" };
  if (owner.nothingPriced) return { status: "provider-not-modelled", substrate: owner.nothingPriced };

  const type = owner.resolveType ? owner.resolveType(props) : entityType;
  if (type === undefined) return { status: "unknown-type" };

  if (owner.mapped && Object.prototype.hasOwnProperty.call(owner.mapped, type)) {
    const row = owner.mapped[type];
    return { status: "mapped", mapping: { ...row, provider: row.provider ?? owner.provider } };
  }
  if (owner.unmapped && Object.prototype.hasOwnProperty.call(owner.unmapped, type)) {
    return { status: "declared-unmapped", reason: owner.unmapped[type] };
  }
  const late = owner.unmappedWhen?.(type);
  if (late !== undefined) return { status: "declared-unmapped", reason: late };
  return { status: "unknown-type" };
}
