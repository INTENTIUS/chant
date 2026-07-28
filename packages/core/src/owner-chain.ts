/**
 * Owner-chain classification (chant #1077).
 *
 * `describeResources()` already lets a lexicon report a live object it never
 * asked about by name — that is how `orphan` has always worked (a resource
 * present in `observedNow` that is not in `declared`). Every existing consumer
 * treats every such object the same way: undeclared, so a delete/adopt
 * candidate.
 *
 * On Kubernetes that conflates two different things. A console-added SNS
 * subscription (the AWS case #1014/#1015 was built for) really is out-of-band
 * drift. A Pod a declared Deployment's controller created is not drift at
 * all — it is the runtime doing its job, and it will be recreated the moment
 * it is deleted. `ownerReferences` is what tells them apart: the Pod's chain
 * of owners terminates at the Deployment, which is declared.
 *
 * This module owns the *category* — the four possible answers to "where does
 * this object's owner chain lead" — and the pure algorithm that walks a chain
 * to one of them. A lexicon supplies the chain (reading `ownerReferences`,
 * possibly across several API reads to walk past an intermediate object chant
 * never declared, e.g. a ReplicaSet between a Pod and its Deployment); this
 * module supplies the bounded, cycle-safe interpretation, so that logic is
 * written and tested once rather than once per lexicon.
 */

/**
 * Where a live, undeclared resource's owner-reference chain leads.
 *
 * - `declared` — the chain reaches an entity chant's own build declared. This
 *   is the whole point of #1077: the diff engine reads this as `runtime`, not
 *   `orphan`, and never proposes deleting it.
 * - `unowned` — the resource carries no owner reference at all. A genuinely
 *   standalone live object; classifies as `orphan`, unchanged from before this
 *   module existed.
 * - `foreign` — the chain fully resolves (every hop was readable, no cycle, no
 *   depth bound hit) but terminates at a live root that is not declared.
 *   Still `orphan` — it belongs to something real, just not to this build.
 * - `unknown` — some hop could not be resolved: an unreadable owner, a cycle,
 *   or the depth bound. Composes with #1168's tri-state precedent: an owner
 *   chain chant could not fully verify is not a confirmed anything, so it is
 *   never escalated to `declared` and stays routed as `orphan` today, exactly
 *   as `foreign`/`unowned` are — never treated as a safer-than-warranted
 *   `runtime` classification just because the read was incomplete.
 */
export type OwnerChainVerdict =
  | { readonly root: "declared"; readonly entity: string }
  | { readonly root: "unowned" }
  | { readonly root: "foreign" }
  | { readonly root: "unknown" };

/**
 * One node in the owner graph a lexicon assembles for {@link classifyOwnerChain}.
 * Keyed externally (in the `nodes` map passed to the walk) by whatever stable
 * identity the lexicon's provider uses — a Kubernetes UID, for instance.
 */
export interface OwnerChainNode {
  /**
   * This node's immediate owner, by its key in the same `nodes` map. Omit
   * (`undefined`) when the object carries no owner reference at all — that is
   * how a chain's *starting* node reports `unowned` rather than `unknown`.
   */
  ownerId?: string;
  /**
   * True when this node's own owner could not be determined — the read
   * failed, was denied, or the object simply could not be fetched. Distinct
   * from having no owner: this says "unknown", not "none".
   */
  ownerUnreadable?: boolean;
  /**
   * The declared chant entity name, when this node corresponds to one. A node
   * with this set ends the walk immediately with `{ root: "declared" }` —
   * whatever `ownerId`/`ownerUnreadable` it might also carry is irrelevant,
   * since the chain already reached what it was looking for.
   */
  declaredEntity?: string;
}

/** Default bound on how many owner hops {@link classifyOwnerChain} will walk
 * before giving up conservatively. Kubernetes' own garbage collector does not
 * bound this at all, but a live read has to — a bound this generous is well
 * past any real ownership depth (Pod → ReplicaSet → Deployment is 2 hops) and
 * exists only to turn a corrupt or adversarial chain into `unknown` rather
 * than an infinite walk. */
export const DEFAULT_MAX_OWNER_CHAIN_DEPTH = 12;

/**
 * Walk the owner chain starting at `startId` through `nodes`, bounded and
 * cycle-safe. Pure — the caller has already done whatever I/O was needed to
 * populate `nodes`; this function only interprets the graph it was given.
 *
 * `nodes` need not contain every ancestor: a node the caller never resolved
 * (because it gave up, hit the caller's own fetch bound, or the read failed)
 * is simply absent from the map, and a reference to an absent node classifies
 * as `unknown` — the conservative answer, same as an explicit
 * `ownerUnreadable`.
 */
export function classifyOwnerChain(
  startId: string,
  nodes: ReadonlyMap<string, OwnerChainNode>,
  maxDepth: number = DEFAULT_MAX_OWNER_CHAIN_DEPTH,
): OwnerChainVerdict {
  const start = nodes.get(startId);
  if (!start) return { root: "unknown" };
  if (start.declaredEntity) return { root: "declared", entity: start.declaredEntity };
  if (start.ownerUnreadable) return { root: "unknown" };
  if (start.ownerId === undefined) return { root: "unowned" };

  const visited = new Set<string>([startId]);
  let currentId = start.ownerId;

  for (let depth = 0; depth < maxDepth; depth++) {
    if (visited.has(currentId)) return { root: "unknown" }; // cycle
    visited.add(currentId);

    const node = nodes.get(currentId);
    if (!node) return { root: "unknown" }; // referenced but never resolved
    if (node.declaredEntity) return { root: "declared", entity: node.declaredEntity };
    if (node.ownerUnreadable) return { root: "unknown" };
    if (node.ownerId === undefined) return { root: "foreign" }; // a real, live, undeclared root

    currentId = node.ownerId;
  }

  // The bound was hit without resolving to a declared entity or a definite
  // root. Conservative: not a confirmed `foreign` either, since one more hop
  // might have reached a declared entity — see the type doc on `unknown`.
  return { root: "unknown" };
}
