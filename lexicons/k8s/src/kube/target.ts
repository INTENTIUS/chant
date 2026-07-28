/**
 * Resolving `chant kube <verb> <target...>`'s positional arguments to an
 * addressable resource (chant #1079).
 *
 * "Every verb resolves entity names through chant's own vocabulary where
 * applicable ... while also accepting raw kind/name kubectl-style." Both
 * forms share one positional shape, disambiguated by arity:
 *
 * - One token, and it names a declared entity in this project → chant's own
 *   vocabulary: the entity's `metadata.name`(/`namespace`) is looked up in
 *   its own source, not typed twice.
 * - One or two tokens otherwise → kubectl's own shape, `<kind> [name]`; a
 *   bare kind with no name is a list, matching `kubectl get <kind>`.
 *
 * `<kind>` is never parsed here beyond splitting the `.group` suffix — that
 * job belongs to the typed client's own `resolve()` (kubectl's own
 * plural/singular/kind/short-name precedence, `packages/k8s-client/src/client.ts`),
 * so a raw kind string reaches the cluster exactly as `kubectl get raycluster.ray.io`
 * would.
 */

import type { ResourceSelector } from "@intentius/chant-k8s-client";
import { findDeclaredMatch, type DeclaredMatch, type KubeProjectContext } from "./project";
import { operationFor } from "../api/operation-surface";

export interface KubeTarget {
  selector: ResourceSelector;
  /** Object name. Undefined means "list every object this selector addresses". */
  name?: string;
  namespace?: string;
  /** Set when resolution went through chant's own vocabulary rather than a kubectl kind string. */
  declaredMatch?: DeclaredMatch;
}

export interface KubeTargetError {
  error: string;
}

export function isTargetError(t: KubeTarget | KubeTargetError): t is KubeTargetError {
  return "error" in t;
}

/**
 * Resolve `positional` (whatever's left after flags) plus an explicit
 * `-n/--namespace`, against `project`'s declared entities when available.
 */
export function resolveKubeTarget(
  positional: readonly string[],
  namespaceFlag: string | undefined,
  project: KubeProjectContext | undefined,
): KubeTarget | KubeTargetError {
  if (positional.length === 0) {
    return { error: "a resource kind (and, usually, a name) is required — e.g. `chant kube get deployments` or `chant kube get deployment web`" };
  }
  const [first, second] = positional;

  if (project && second === undefined) {
    const entity = project.entities.get(first);
    if (entity && entity.lexicon === "k8s") {
      const operation = operationFor(entity.entityType);
      const props = "props" in entity ? ((entity as { props: unknown }).props as Record<string, unknown>) : undefined;
      const metadata = props?.metadata as { name?: string; namespace?: string } | undefined;
      if (operation && metadata?.name) {
        return {
          selector: { apiVersion: operation.apiVersion, kind: operation.kind },
          name: metadata.name,
          namespace: namespaceFlag ?? metadata.namespace,
          declaredMatch: { entityName: first, entity, props },
        };
      }
    }
  }

  return { selector: { resource: first }, name: second, namespace: namespaceFlag };
}

/**
 * After a live read resolves an object's real `apiVersion`/`kind` (a kubectl
 * kind string like `deploy` isn't one), reverse-map it against the project
 * for the verdict column / `source` — reusing the exact match `resolveKubeTarget`
 * would have made had the caller spelled out the entity name.
 */
export function matchLiveObject(
  project: KubeProjectContext | undefined,
  ref: { apiVersion: string; kind: string; name: string; namespace?: string },
): DeclaredMatch | undefined {
  if (!project) return undefined;
  return findDeclaredMatch(project.entities, ref);
}
