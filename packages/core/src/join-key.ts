/**
 * The one join key for names matched across projects (#2524 D6, ws-008).
 *
 * A consumer's parameter and a producer's output are joined by name when
 * nobody wrote the join down. Deploy matches names exactly, and real projects
 * rarely spell both sides the same (`clusterArn` against `ClusterArn`), so an
 * inferred join compares {@link joinKey}s and says how it matched: `exact`
 * when the names are equal, `folded` when only case or punctuation differ.
 * A declared member link is always compared exactly and never uses this.
 *
 * Before this module, core only published the handles (a graph IR's
 * `exports` and `imports`) and each viewer matched them with its own rule.
 * Every reader that infers a join by name uses this function instead, so the
 * same workspace shows the same inferred edges everywhere. It imports nothing,
 * so any reader can load it through `@intentius/chant/join-key`.
 */

/** How an inferred join matched its two names. */
export type JoinLabel = "exact" | "folded";

/**
 * The key two names are joined on: Unicode-normalised, lowercased, with every
 * character that is not a letter or a digit removed. `ClusterArn`,
 * `clusterArn`, `cluster_arn` and `cluster-arn` share the key `clusterarn`.
 */
export function joinKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * How `a` and `b` join: `exact` when they are the same string, `folded` when
 * only their {@link joinKey}s are equal, and undefined when they don't join.
 * Names whose key is empty never join.
 */
export function joinLabel(a: string, b: string): JoinLabel | undefined {
  if (a === b) return a === "" ? undefined : "exact";
  const key = joinKey(a);
  return key !== "" && key === joinKey(b) ? "folded" : undefined;
}
