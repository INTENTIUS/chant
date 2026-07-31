/**
 * Replay a recorded snapshot as if it had just been observed (#1266, #1279).
 *
 * Shared by `chant search --at` and `chant graph --at`. A snapshot already holds
 * what an observation is — resources with their physical ids and attributes,
 * and since #1266 the relationships between them — so turning it back into
 * `LiveObservation[]` lets a replay rejoin the live path at `buildLiveGraphIr`.
 * Every fold, overlay and edge reconstruction below that point is shared, and
 * nothing downstream needs to know which source it got.
 *
 * That sharing is the reason this is a module rather than a helper inside one
 * command: `graph` had no `--at` at all, so anyone wanting the raw IR of a
 * recorded estate had to reach for the live endpoint, and a snapshot could
 * answer most questions but never all of them.
 */

import { readEnvironmentSnapshots } from "./git";
import type { LiveObservation } from "../graph-ir";
import type { LifecycleSnapshot } from "./types";

/**
 * Rebuild observations from a recorded snapshot (#1266).
 *
 * A snapshot already holds what an observation is: resources with their
 * physical ids and attributes, and — since #1266 — the relationships between
 * them. Turning it back into `LiveObservation[]` means the replay rejoins the
 * live path at `buildLiveGraphIr`, and every fold, overlay and query below that
 * is shared. Nothing downstream needs to know which source it got.
 *
 * `latest` is the only ref for now. A specific commit is the natural extension
 * and the storage already supports it (`readSnapshotAt`), but "answer from what
 * is recorded" is the question worth settling first.
 */
/**
 * Whether this environment has a recording, without reading one.
 *
 * Used to turn "the estate could not be read" into "the estate could not be
 * read, and you already have a recording of it". Cheap and best-effort: a
 * failure here means the caller says the plain version of the message, never
 * that the command fails.
 */
export async function hasSnapshot(environment: string): Promise<boolean> {
  try {
    return (await readEnvironmentSnapshots(environment)).size > 0;
  } catch {
    return false;
  }
}

export async function replaySnapshots(
  environment: string,
  ref: string,
  scopedStacks: Set<string>,
): Promise<{ observations: LiveObservation[]; commit: string; timestamp: string } | { error: string; hint?: string }> {
  if (ref !== "latest" && ref !== "true") {
    return {
      error: `chant search --at only accepts "latest" for now, got "${ref}"`,
      hint: "a specific snapshot commit is not wired up yet",
    };
  }
  const stored = await readEnvironmentSnapshots(environment);
  if (stored.size === 0) {
    return {
      error: `No snapshots found for environment "${environment}"`,
      hint: `Record one first: chant lifecycle snapshot ${environment}`,
    };
  }
  const observations: LiveObservation[] = [];
  let commit = "";
  let timestamp = "";
  // Ambient and dependency resources are keyed by physical id and are
  // account-level: the default security group three stacks each recorded is one
  // group, not three. Managed resources are stack-qualified below and cannot
  // collide, so only the unqualified ones need this.
  const seenUnqualified = new Set<string>();
  // A stack's snapshot could only exclude what THAT stack manages, so a stack
  // declaring no security groups reported the neighbouring stack's as ambient.
  // The union is only knowable here, with every snapshot in hand.
  const managedPhysicalIds = new Set<string>();
  for (const content of stored.values()) {
    const snap = JSON.parse(content) as LifecycleSnapshot;
    for (const meta of Object.values(snap.resources ?? {})) {
      if (!meta.ambient && !meta.referencedBy?.length && meta.physicalId) {
        managedPhysicalIds.add(meta.physicalId);
      }
    }
  }
  for (const [key, content] of stored) {
    const snapshot = JSON.parse(content) as LifecycleSnapshot;
    // The storage key is `<stack>__<lexicon>` for a multi-stack project; the
    // snapshot carries its own lexicon, which is the one to trust.
    const lexicon = snapshot.lexicon ?? key;
    // A scoped stack's ids are qualified `${stack}::${id}` on the live path
    // (#1162), because the same bare LogicalResourceId exists in every region's
    // stack. A snapshot stores them bare, so a replay has to re-apply the same
    // rule — otherwise `server` from us-west-1 and `server` from us-west-2
    // collide, and none of them join the declared canvas, which qualifies.
    const stack = snapshot.stack;
    const qualify = stack !== undefined && scopedStacks.has(stack);
    // Dependencies (#1273) are keyed by physical id and are account-level: the
    // default VPC's route table is one resource however many stacks route
    // through it. Qualifying those would split it per stack and break the
    // edges into it.
    const managed = (id: string, meta: { referencedBy?: string[]; ambient?: boolean }): string =>
      qualify && !meta.ambient && !(meta.referencedBy && meta.referencedBy.length > 0)
        ? `${stack}::${id}`
        : id;
    const resources: Record<string, (typeof snapshot.resources)[string]> = {};
    for (const [id, meta] of Object.entries(snapshot.resources ?? {})) {
      const key = managed(id, meta);
      if (key === id) {
        // Ambient means "nothing manages this". Another stack managing it makes
        // that false, and reporting it twice would inflate any count over it.
        if (meta.ambient && meta.physicalId && managedPhysicalIds.has(meta.physicalId)) continue;
        // Unqualified: account-level, so first sighting wins and the rest are
        // the same resource seen again from another stack's snapshot.
        if (seenUnqualified.has(id)) continue;
        seenUnqualified.add(id);
      }
      resources[key] = meta;
    }
    const known = new Set(Object.keys(snapshot.resources ?? {}));
    const requalify = (id: string): string => {
      const meta = (snapshot.resources ?? {})[id];
      return known.has(id) && meta ? managed(id, meta) : id;
    };
    const edges = (snapshot.edges ?? []).map((e) => ({ ...e, from: requalify(e.from), to: requalify(e.to) }));
    observations.push({
      lexicon,
      resources,
      ...(edges.length > 0 ? { edges } : {}),
    });
    commit ||= snapshot.commit ?? "";
    // Report the OLDEST timestamp across stacks: a caller asking how stale this
    // answer is wants the weakest link, not the freshest one.
    if (!timestamp || (snapshot.timestamp && snapshot.timestamp < timestamp)) {
      timestamp = snapshot.timestamp ?? timestamp;
    }
  }
  return { observations, commit, timestamp };
}
