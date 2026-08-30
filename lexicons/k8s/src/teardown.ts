/**
 * Env teardown for the k8s lexicon (chant #1222) — both halves of the
 * `teardownOwned` / `executeTeardown` capability pair.
 *
 * Selection is the prune's marker selector (op/activities/kubectl.ts) with the
 * env dimension added: `app.kubernetes.io/managed-by=chant` +
 * `chant.intentius.io/stack=<stack>` + `chant.intentius.io/env=<env>`, sent to
 * the server as a label selector and re-checked object by object with
 * `readOwnership` — the server-side filter narrows the read, the client-side
 * re-check is the one that matters, because a delete is not undoable.
 *
 * Swept kinds are chant's default sweep set (`DEFAULT_IMPORT_TYPES`, the same
 * list the ownership-scoped prune unions in), listed cluster-wide: env
 * teardown has no apply set to scope namespaces by, and the marker selector is
 * the scope. A kind the cluster's discovery does not serve cannot hold a
 * marked object and is skipped; a kind that resolves but fails to list is a
 * hole (#1089) — unknown, never absent.
 *
 * Execution deletes the handed-over candidates through the typed client's own
 * `delete()` — the identical delete the prune and `chant kube delete` use —
 * with namespaces last, so a namespace's own members get individual outcomes
 * before the cascade would have swallowed them. Before each delete the live
 * object is re-read and its marker re-verified; an object that vanished is
 * `deleted` (teardown is idempotent), one whose identity no longer matches is
 * `not-prunable`, never deleted.
 */

import type {
  TeardownCandidate,
  TeardownEnumeration,
  TeardownExecution,
  TeardownHole,
  TeardownOutcome,
} from "@intentius/chant/lexicon";
import {
  LABEL_OWNERSHIP_KEYS,
  OWNERSHIP_MANAGED_BY_VALUE,
  readOwnership,
  type OwnershipMarker,
} from "@intentius/chant/ownership";
import type { K8sClient } from "@intentius/chant-k8s-client";
import { DEFAULT_IMPORT_TYPES } from "./api/sweep-types";
import { operationFor } from "./api/operation-surface";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import { isGeneratedOnce } from "./secret-labels";

const NAMESPACE_TYPE = "K8s::Core::Namespace";

export interface K8sTeardownOptions {
  environment: string;
  marker: OwnershipMarker;
}

/** The label selector that scopes everything here: managed-by + stack + env. */
function markerSelector(marker: OwnershipMarker): string {
  return [
    `${LABEL_OWNERSHIP_KEYS.managedBy}=${OWNERSHIP_MANAGED_BY_VALUE}`,
    `${LABEL_OWNERSHIP_KEYS.stack}=${marker.stack}`,
    ...(marker.env ? [`${LABEL_OWNERSHIP_KEYS.env}=${marker.env}`] : []),
  ].join(",");
}

/** True when a live object's own labels carry exactly the requested identity. */
function matchesMarker(
  labels: Record<string, string> | undefined,
  marker: OwnershipMarker,
): boolean {
  const read = readOwnership(labels, LABEL_OWNERSHIP_KEYS);
  return read !== undefined && read.stack === marker.stack && read.env === marker.env;
}

/**
 * Enumerate the cluster's marker-matching objects — the k8s half of
 * `chant lifecycle teardown <env>` planning.
 */
export async function teardownOwned(
  options: K8sTeardownOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<TeardownEnumeration> {
  const { client } = await connect({ environment: options.environment });
  const selector = markerSelector(options.marker);

  const candidates: TeardownCandidate[] = [];
  const holes: TeardownHole[] = [];

  for (const entityType of DEFAULT_IMPORT_TYPES) {
    const operation = operationFor(entityType);
    if (!operation) continue;
    const ref = { apiVersion: operation.apiVersion, kind: operation.kind };

    let served: boolean;
    try {
      served = (await client.resolve(ref)) !== undefined;
    } catch (err) {
      holes.push({
        name: entityType,
        type: entityType,
        reason: "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // A kind this cluster's discovery does not serve cannot hold a marked
    // object — absence of the kind is knowledge, not a hole.
    if (!served) continue;

    let items;
    try {
      items = await client.list(ref, { labelSelector: selector });
    } catch (err) {
      holes.push({
        name: entityType,
        type: entityType,
        reason: "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const item of items) {
      const name = item.metadata?.name;
      if (!name) continue;
      // The re-check that matters: a server (or fake) that ignored the label
      // selector must not widen the set past the requested identity.
      if (!matchesMarker(item.metadata?.labels, options.marker)) continue;
      // Already terminating — deleting again is noise, not progress.
      if (item.metadata?.deletionTimestamp !== undefined) continue;
      const namespace = item.metadata?.namespace;
      candidates.push({
        name: namespace ? `${namespace}/${name}` : name,
        type: entityType,
        ...(item.metadata?.uid ? { physicalId: String(item.metadata.uid) } : {}),
        marker: readOwnership(item.metadata?.labels, LABEL_OWNERSHIP_KEYS)!,
      });
    }
  }

  return { candidates, ...(holes.length > 0 ? { holes } : {}) };
}

/**
 * Delete the handed-over candidates, namespaces last. One outcome per
 * candidate, always.
 */
export async function executeTeardown(
  options: K8sTeardownOptions & { candidates: TeardownCandidate[] },
  connect: K8sConnector = defaultK8sConnector,
): Promise<TeardownExecution> {
  const { client } = await connect({ environment: options.environment });

  // Namespaces last: their members get individual deletes (and individual
  // outcomes) before the namespace cascade sweeps whatever is left.
  const ordered = [
    ...options.candidates.filter((c) => c.type !== NAMESPACE_TYPE),
    ...options.candidates.filter((c) => c.type === NAMESPACE_TYPE),
  ];

  const outcomes: TeardownOutcome[] = [];
  for (const candidate of ordered) {
    outcomes.push(await deleteCandidate(client, candidate, options.marker));
  }
  return { outcomes };
}

async function deleteCandidate(
  client: K8sClient,
  candidate: TeardownCandidate,
  marker: OwnershipMarker,
): Promise<TeardownOutcome> {
  const base = {
    name: candidate.name,
    type: candidate.type,
    ...(candidate.physicalId ? { physicalId: candidate.physicalId } : {}),
  };

  const operation = operationFor(candidate.type);
  if (!operation) {
    return { ...base, outcome: "not-prunable", detail: `no operation mapping for type ${candidate.type}` };
  }

  let info;
  try {
    info = await client.resolve({ apiVersion: operation.apiVersion, kind: operation.kind });
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!info) {
    return { ...base, outcome: "not-prunable", detail: `the cluster does not serve ${operation.kind}` };
  }

  const slash = candidate.name.indexOf("/");
  const namespace = info.namespaced && slash > 0 ? candidate.name.slice(0, slash) : undefined;
  const name = info.namespaced && slash > 0 ? candidate.name.slice(slash + 1) : candidate.name;
  const ref = {
    apiVersion: operation.apiVersion,
    kind: operation.kind,
    name,
    ...(namespace !== undefined ? { namespace } : {}),
  };

  // Re-read and re-verify the identity right before deleting: the enumeration
  // is a moment old at best, and a delete is not undoable.
  let live;
  try {
    live = await client.readIfPresent(ref);
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (live === undefined) {
    return { ...base, outcome: "deleted", detail: "already absent" };
  }
  if (!matchesMarker(live.metadata?.labels, marker)) {
    return {
      ...base,
      outcome: "not-prunable",
      detail: "the live object no longer carries the requested marker identity",
    };
  }
  // A generated-once Secret survives every sweep, env teardown included
  // (#1830, epic #1365 decision 5): the stored bytes are the only copy of
  // material chant never held. `retained` is the loud keep — the row says the
  // env is not clean and why. Deletion is an explicit act (`kubectl delete
  // secret <name>`, or a future gated op), never a teardown's.
  if (operation.kind === "Secret" && isGeneratedOnce(live.metadata?.labels)) {
    return {
      ...base,
      outcome: "retained",
      detail:
        "generated-once secret — deliberately kept, never swept; delete it explicitly (kubectl delete) if you mean to",
    };
  }

  try {
    await client.delete(ref);
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ...base, outcome: "deleted" };
}
