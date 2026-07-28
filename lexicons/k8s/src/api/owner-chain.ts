/**
 * Resolving a live Kubernetes object's `ownerReferences` chain up to a
 * declared, chant-observed entity (chant #1077).
 *
 * There is no server-side "who ultimately owns this object" query — Kubernetes'
 * own garbage collector does not have one either; it walks the same chain one
 * hop at a time, reading each intermediate owner. A Pod's `ownerReferences`
 * names its ReplicaSet, which chant never declared; the ReplicaSet's own
 * `ownerReferences` names the Deployment, which is declared. Reaching that
 * declared entity takes reading the ReplicaSet in between.
 *
 * This module's only job is assembling that chain — fetching each hop through
 * the typed client, bounded and cycle-guarded so a corrupt or adversarial
 * chain cannot hang an observation. The bounded/cycle-safe *interpretation* of
 * the assembled chain (declared / unowned / foreign / unknown) is core's
 * `classifyOwnerChain` (`@intentius/chant/owner-chain`) — the issue's own
 * division of labor: core owns the category, the lexicon supplies the chain.
 */

import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import {
  classifyOwnerChain,
  DEFAULT_MAX_OWNER_CHAIN_DEPTH,
  type OwnerChainNode,
  type OwnerChainVerdict,
} from "@intentius/chant/owner-chain";

interface RawOwnerRef {
  apiVersion?: string;
  kind?: string;
  name?: string;
  uid?: string;
  controller?: boolean;
}

function ownerRefs(obj: K8sObject): RawOwnerRef[] {
  const refs = obj.metadata?.ownerReferences;
  return Array.isArray(refs) ? (refs as RawOwnerRef[]) : [];
}

/**
 * The reference Kubernetes' own garbage collector treats as the controlling
 * parent: the entry with `controller: true`, else the first. An object with
 * several owner references (rare — usually a shared, non-controller owner
 * alongside the controlling one) is walked through its controller, matching
 * what actually recreates the object were it deleted.
 */
function controllingRef(obj: K8sObject): RawOwnerRef | undefined {
  const refs = ownerRefs(obj);
  return refs.find((r) => r.controller === true) ?? refs[0];
}

/** The client surface this module needs — a single object read, addressed by
 * an owner reference's own coordinates. */
export type OwnerChainReader = Pick<K8sClient, "readIfPresent">;

export interface ResolveOwnerChainOptions {
  /** uid → declared chant entity name, from this observation's own resolved entities. */
  declaredByUid: ReadonlyMap<string, string>;
  /** Reads each intermediate owner. */
  reader: OwnerChainReader;
  /**
   * Namespace the starting object lives in. Owner references are same-namespace
   * only — a namespaced object cannot be owned by an object in another
   * namespace, the same rule Kubernetes' own garbage collector enforces —so
   * every hop is read in this namespace.
   */
  namespace: string | undefined;
  maxDepth?: number;
}

/**
 * Walk `obj`'s owner-reference chain up to a declared entity, a foreign root,
 * or a bound (#1077). Fetches at most `maxDepth + 1` objects (the starting
 * object plus up to `maxDepth` ancestors) — the same bound `classifyOwnerChain`
 * enforces when interpreting the result, so nothing is fetched that the
 * interpretation would not have used anyway.
 */
export async function resolveK8sOwnerChain(
  obj: K8sObject,
  options: ResolveOwnerChainOptions,
): Promise<OwnerChainVerdict> {
  const startUid = obj.metadata?.uid;
  if (!startUid) return { root: "unknown" };

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_OWNER_CHAIN_DEPTH;
  const nodes = new Map<string, OwnerChainNode>();
  const visited = new Set<string>();

  let uid: string | undefined = startUid;
  let object: K8sObject | undefined = obj;

  for (let depth = 0; uid !== undefined && depth <= maxDepth; depth++) {
    if (visited.has(uid)) break; // cycle — classifyOwnerChain reads it off `nodes`
    visited.add(uid);

    const declaredEntity = options.declaredByUid.get(uid);
    if (declaredEntity) {
      nodes.set(uid, { declaredEntity });
      break;
    }
    if (!object) {
      nodes.set(uid, { ownerUnreadable: true });
      break;
    }

    const ref = controllingRef(object);
    if (!ref?.uid || !ref.kind || !ref.apiVersion || !ref.name) {
      nodes.set(uid, {}); // no further owner — a real, live root
      break;
    }
    nodes.set(uid, { ownerId: ref.uid });

    if (visited.has(ref.uid)) {
      // About to cycle back to an already-visited node — let the loop's own
      // check classify it next iteration rather than issuing a wasted read.
      uid = ref.uid;
      continue;
    }
    if (options.declaredByUid.has(ref.uid)) {
      // Already known to be a declared entity from this observation's own
      // resolved set — no need to read it, the next iteration resolves it
      // from `declaredByUid` directly.
      uid = ref.uid;
      object = undefined;
      continue;
    }

    try {
      object = await options.reader.readIfPresent({
        apiVersion: ref.apiVersion,
        kind: ref.kind,
        name: ref.name,
        namespace: options.namespace,
      });
    } catch {
      object = undefined;
    }
    if (!object) nodes.set(ref.uid, { ownerUnreadable: true });
    uid = ref.uid;
  }

  return classifyOwnerChain(startUid, nodes, maxDepth);
}
