/**
 * The observation contract (#1089) — what a lexicon's `describeResources()`
 * is allowed to mean.
 *
 * Before this module there were two ways for an observation to return nothing
 * for a declared entity and no way to tell them apart:
 *
 *   1. The provider was asked and said the resource does not exist.
 *   2. The lexicon never looked — no reader for that kind, the read errored,
 *      no credentials, no cluster/subscription binding.
 *
 * Both arrived at the change set as "absent", and absent + declared classifies
 * as `create`. So `chant lifecycle plan` proposed creating a Kubernetes CRD
 * that already existed in the cluster, with nothing in the plan to say the tool
 * had simply not looked (a warn on stderr is not a signal in a change set).
 *
 * The contract is a tri-state, per declared entity:
 *
 *   - **OBSERVED-PRESENT** — a key in `resources`. The provider returned it.
 *   - **OBSERVED-ABSENT** — in neither map. The lexicon looked and the provider
 *     reported it missing. This is the only shape that may become a `create`.
 *   - **NOT-OBSERVED** — a key in `unobserved`, carrying a total
 *     {@link UnobservedReason}. Never a `create`, never a `delete`; consumers
 *     surface it and stop.
 *
 * Compatibility: `describeResources()` may still return the bare
 * `name → ResourceMetadata` map it always did — that means "everything I was
 * asked about, I looked at" and normalizes to an empty `unobserved`. Reporting
 * NOT-OBSERVED requires the explicitly versioned {@link ObservationResult}
 * envelope, which is discriminated by its literal `observation: "v1"` field (a
 * bare map's value at any key is a `ResourceMetadata` object, never that
 * string, so the two shapes can never be confused).
 */

import type { ResourceMetadata } from "./lexicon";

/**
 * Why a declared entity was not observed. Total: a lexicon that cannot observe
 * an entity must pick one of these, and consumers may switch exhaustively.
 *
 * - `read-failed` — the provider was reached and the read errored (a non-zero
 *   CLI exit, a 5xx, an unparseable response).
 * - `no-credentials` — no usable credentials/authorization for the target.
 * - `no-binding` — the environment resolves to no concrete target (no kubectl
 *   context, no subscription, no stack, no endpoint).
 * - `unsupported-kind` — the lexicon has no reader for this entity type (the
 *   K8s CRD case, Azure's nested ARM types). The resource may well exist.
 * - `filtered` — the entity was reached but withheld by a caller-requested
 *   filter (`owned: true` against a resource carrying no chant marker). The
 *   result deliberately says nothing about it, which is still not absence: a
 *   declared resource that exists but is foreign must not classify as `create`.
 */
export type UnobservedReason =
  | "read-failed"
  | "no-credentials"
  | "no-binding"
  | "unsupported-kind"
  | "filtered";

/** Every legal {@link UnobservedReason}, for validation and conformance checks. */
export const UNOBSERVED_REASONS: readonly UnobservedReason[] = [
  "read-failed",
  "no-credentials",
  "no-binding",
  "unsupported-kind",
  "filtered",
];

/** True when `value` is a legal {@link UnobservedReason}. */
export function isUnobservedReason(value: unknown): value is UnobservedReason {
  return typeof value === "string" && (UNOBSERVED_REASONS as readonly string[]).includes(value);
}

/** One declared entity the lexicon could not observe, and why. */
export interface UnobservedEntity {
  /** Declared entity type, when the lexicon knows it (it usually does — the entity is declared). */
  type?: string;
  /** Total verdict. */
  reason: UnobservedReason;
  /** Human-readable detail: the command that failed, the missing binding key, the unsupported kind. */
  detail?: string;
  /**
   * The resolved address the read was issued against (#1620) — for k8s the
   * request path (`/apis/apps/v1/namespaces/default/deployments/web`), for
   * other substrates whatever names the endpoint/region/account actually
   * asked. Optional and purely diagnostic: it never changes the verdict, it
   * lets a consumer tell "looked in the wrong place" from "not there".
   */
  queried?: string;
}

/**
 * The observation envelope — a `describeResources()` return value that can say
 * "I did not look at this one". Explicitly versioned: `observation: "v1"`.
 */
export interface ObservationResult {
  /** Discriminant + wire version. Distinguishes the envelope from the bare `name → ResourceMetadata` map. */
  readonly observation: "v1";
  /** OBSERVED-PRESENT, keyed by chant entity name. */
  resources: Record<string, ResourceMetadata>;
  /** NOT-OBSERVED, keyed by chant entity name. Omit or leave empty when everything asked about was looked at. */
  unobserved?: Record<string, UnobservedEntity>;
  /**
   * The resolved query address per declared entity (#1620), keyed by chant
   * entity name — what was actually asked of the provider, whatever the
   * verdict came back as. Additive metadata over the tri-state, never part of
   * it: classification still reads only `resources` and `unobserved`, and an
   * entity in neither map is still OBSERVED-ABSENT whether or not it appears
   * here. This map is the only place an ABSENT entity can carry its address —
   * absence is spelled "in neither map", so there is no row to hang it on —
   * which is exactly the entry that lets a consumer see that a defaulted
   * namespace, endpoint or region was read, not the one the resource lives in.
   */
  queried?: Record<string, string>;
  /**
   * Notices about the read as a whole, not about any one entity (#1265) —
   * "the ownership filter could not be applied on this surface" is the
   * canonical one. A note is a property of the environment or the read path,
   * so core says each distinct note once per run, after the answer, however
   * many stacks or lexicons reported it. A lexicon returns it here instead of
   * printing, so the note cannot land ahead of the rows it qualifies.
   */
  notes?: string[];
}

/**
 * What `describeResources()` may return: the bare map (pre-#1089, still valid —
 * "I looked at everything") or the {@link ObservationResult} envelope.
 */
export type DescribeResourcesResult = Record<string, ResourceMetadata> | ObservationResult;

/** Normalized form every consumer works with. All maps always present. */
export interface NormalizedObservation {
  resources: Record<string, ResourceMetadata>;
  unobserved: Record<string, UnobservedEntity>;
  /** Resolved query address per entity name (#1620). Empty when the lexicon reported none. */
  queried: Record<string, string>;
  /** Run-level notices (#1265), distinct. Empty when the lexicon reported none. */
  notes: string[];
}

/** True when `value` is the versioned {@link ObservationResult} envelope. */
export function isObservationResult(value: unknown): value is ObservationResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { observation?: unknown }).observation === "v1"
  );
}

/**
 * Build an {@link ObservationResult}. Lexicons use this rather than writing the
 * discriminant by hand.
 */
export function observation(
  resources: Record<string, ResourceMetadata>,
  unobserved?: Record<string, UnobservedEntity>,
  queried?: Record<string, string>,
  notes?: string[],
): ObservationResult {
  return {
    observation: "v1",
    resources,
    ...(unobserved && Object.keys(unobserved).length > 0 ? { unobserved } : {}),
    ...(queried && Object.keys(queried).length > 0 ? { queried } : {}),
    ...(notes && notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Normalize either accepted return shape. `undefined` (a lexicon that returned
 * nothing at all) normalizes to two empty maps — which reads as "everything was
 * observed absent", so callers that mean "the read failed" must say so with
 * {@link unobservedAll} rather than returning nothing.
 */
export function normalizeObservation(value: DescribeResourcesResult | undefined): NormalizedObservation {
  if (!value) return { resources: {}, unobserved: {}, queried: {}, notes: [] };
  if (isObservationResult(value)) {
    return {
      resources: value.resources ?? {},
      unobserved: value.unobserved ?? {},
      queried: value.queried ?? {},
      notes: [...new Set(value.notes ?? [])],
    };
  }
  return { resources: value, unobserved: {}, queried: {}, notes: [] };
}

/**
 * Mark every named entity NOT-OBSERVED with one reason — the whole-lexicon
 * failure case (the provider CLI is missing, the cluster binding refused, the
 * credentials are gone). Core applies this when `describeResources()` throws,
 * so a thrown read degrades to an honest "did not look" for each declared
 * entity instead of an empty map that classifies as N creates.
 */
export function unobservedAll(
  names: Iterable<string>,
  reason: UnobservedReason,
  detail?: string,
  types?: Map<string, { entityType: string }> | Record<string, string>,
): Record<string, UnobservedEntity> {
  const typeOf = (name: string): string | undefined => {
    if (!types) return undefined;
    if (types instanceof Map) return types.get(name)?.entityType;
    return types[name];
  };
  const out: Record<string, UnobservedEntity> = {};
  for (const name of names) {
    const type = typeOf(name);
    out[name] = { reason, ...(type ? { type } : {}), ...(detail ? { detail } : {}) };
  }
  return out;
}

/**
 * Union several observations of the same lexicon (the multi-stack read, where
 * `describeResources` runs once per stack). Precedence is
 * present > not-observed > absent: a resource found in any stack is present; an
 * entity nobody could look at stays not-observed; an entity every reader looked
 * for and did not find is absent.
 */
export function mergeObservations(parts: Iterable<NormalizedObservation>): NormalizedObservation {
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const queried: Record<string, string> = {};
  // A note is about the read, not a stack; four stacks saying the same thing
  // is one note (#1265).
  const notes = new Set<string>();
  for (const part of parts) {
    Object.assign(resources, part.resources);
    Object.assign(unobserved, part.unobserved);
    Object.assign(queried, part.queried);
    for (const n of part.notes) notes.add(n);
  }
  // Present wins: a stack that could not be read does not un-observe a resource
  // another stack returned.
  for (const name of Object.keys(resources)) delete unobserved[name];
  return { resources, unobserved, queried, notes: [...notes] };
}

/** One-line human phrasing of a reason, for CLI output. */
export function unobservedReasonText(reason: UnobservedReason): string {
  switch (reason) {
    case "read-failed":
      return "read failed";
    case "no-credentials":
      return "no credentials";
    case "no-binding":
      return "no binding for this environment";
    case "unsupported-kind":
      return "no reader for this resource kind";
    case "filtered":
      return "withheld by the --owned filter";
  }
}

/** `name — reason (detail) [queried address]`, the shared rendering for CLI and plan output. */
export function formatUnobserved(name: string, entry: UnobservedEntity): string {
  const base = `${name}${entry.type ? ` (${entry.type})` : ""} — ${unobservedReasonText(entry.reason)}`;
  const detailed = entry.detail ? `${base}: ${entry.detail}` : base;
  return entry.queried ? `${detailed} [queried ${entry.queried}]` : detailed;
}

/* ------------------------------------------------------------------------- *
 * The observer harness (#1201).
 *
 * Every native observer runs the same control flow: bind to the provider on
 * the applier's own transport, read the declared entities concurrently, and
 * turn each read into one of the tri-state outcomes above. The k8s observer
 * (#1074) and Fly (#767) already embody it. Rather than have aws/gcp/azure each
 * re-derive it — and re-derive it inconsistently, which is how the shell-out
 * observers drifted apart — a lexicon supplies an {@link ObserverAdapter} and
 * the harness owns the shape: bind-or-not-observe-all with a typed reason,
 * bounded concurrency, per-entity tri-state routing, and a per-entity throw
 * degrading to `read-failed` rather than a silent absence.
 *
 * The adapter owns transport and endpoint resolution (an emulator override is
 * resolved inside `bind()` via the shared live-endpoint helper), so the
 * emulator override behaves identically across lexicons by construction — the
 * harness never touches an endpoint itself.
 * ------------------------------------------------------------------------- */

/** One declared entity handed to the harness. */
export interface DeclaredEntity {
  /** chant entity name — the key every outcome is filed under. */
  name: string;
  /** Declared entity type (e.g. `AWS::EC2::VPC`). */
  type: string;
  /** Declared properties, for the adapter to derive a physical address from. */
  props: Record<string, unknown>;
}

/**
 * The outcome of reading one entity, mapped onto the tri-state:
 * - `present` — a key in `resources`.
 * - `absent` — in neither map (the provider was asked and reported it missing).
 * - `unobserved` — a typed NOT-OBSERVED (unsupported kind, filtered, read error).
 *
 * Every variant may carry `queried` (#1620): the resolved address the read was
 * issued against. The harness collects it into the result's `queried` map (and
 * onto the unobserved entry), so even an absent verdict — which records
 * nothing else — says where the provider was asked.
 */
export type EntityObservation =
  | { present: ResourceMetadata; queried?: string }
  | { absent: true; queried?: string }
  | { unobserved: { reason: UnobservedReason; detail?: string }; queried?: string };

/** What a lexicon supplies to drive the harness. `Client` is its transport handle. */
export interface ObserverAdapter<Client> {
  /**
   * Reach the provider on the applier's transport. Throw for a whole-lexicon
   * failure; {@link classifyBindFailure} decides what the throw means.
   */
  bind(): Promise<Client>;
  /**
   * Map a `bind()` throw to a typed whole-lexicon reason (every entity becomes
   * NOT-OBSERVED with it), or `"rethrow"` for a loud refusal that must not be
   * swallowed — a context/subscription mismatch, which core turns into an
   * honest hole per entity at a higher layer.
   */
  classifyBindFailure(err: unknown): { reason: UnobservedReason; detail?: string } | "rethrow";
  /** Read one declared entity. A throw here is caught and recorded `read-failed`. */
  read(client: Client, entity: DeclaredEntity): Promise<EntityObservation>;
  /**
   * Run `fn` over `items` concurrently. Supply the transport's own bounded pool
   * (the k8s client's `concurrently`, say); when omitted the harness uses
   * {@link boundedConcurrently}, so "N entities is not N serial spawns" holds
   * for every lexicon whether or not its transport ships a pool.
   */
  concurrently?<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void>;
}

/** Default concurrency for {@link boundedConcurrently} when a transport ships no pool. */
export const DEFAULT_OBSERVE_CONCURRENCY = 16;

/**
 * Run `fn` over `items` with at most `limit` in flight. A rejected `fn` rejects
 * the whole run (the harness wraps per-entity reads so this stays for genuinely
 * unexpected faults).
 */
export async function boundedConcurrently<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  limit: number = DEFAULT_OBSERVE_CONCURRENCY,
): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(limit, queue.length || 1));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}

/**
 * The shared observer control flow (#1201). Binds via the adapter, reads every
 * declared entity concurrently, and assembles the tri-state {@link ObservationResult}.
 *
 * A `bind()` throw becomes NOT-OBSERVED for every entity (typed by
 * {@link ObserverAdapter.classifyBindFailure}) unless the adapter asks to
 * rethrow. A per-entity `read()` throw the adapter did not itself map becomes
 * `read-failed` for that one entity — never a silent absence, which would
 * classify as a spurious `create`.
 */
export async function observeEntities<Client>(
  declared: readonly DeclaredEntity[],
  adapter: ObserverAdapter<Client>,
): Promise<ObservationResult> {
  const typesByName: Record<string, string> = {};
  for (const d of declared) typesByName[d.name] = d.type;

  let client: Client;
  try {
    client = await adapter.bind();
  } catch (err) {
    const verdict = adapter.classifyBindFailure(err);
    if (verdict === "rethrow") throw err;
    return observation(
      {},
      unobservedAll(
        declared.map((d) => d.name),
        verdict.reason,
        verdict.detail,
        typesByName,
      ),
    );
  }

  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const queried: Record<string, string> = {};
  const run = adapter.concurrently ?? ((items, fn) => boundedConcurrently(items, fn));

  await run(declared, async (entity) => {
    let result: EntityObservation;
    try {
      result = await adapter.read(client, entity);
    } catch (err) {
      result = {
        unobserved: {
          reason: "read-failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (result.queried) queried[entity.name] = result.queried;
    if ("present" in result) {
      resources[entity.name] = result.present;
    } else if ("unobserved" in result) {
      unobserved[entity.name] = {
        type: entity.type,
        ...result.unobserved,
        ...(result.queried ? { queried: result.queried } : {}),
      };
    }
    // `absent`: the verdict records nothing — in neither map is how the
    // contract spells absence — but its address, when the adapter supplied
    // one, lands in `queried` (#1620) so the absence can explain itself.
  });

  return observation(resources, unobserved, queried);
}
