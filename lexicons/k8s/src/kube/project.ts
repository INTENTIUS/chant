/**
 * Best-effort chant-project context for `chant kube` (chant #1079).
 *
 * `get`'s chant-verdict column and `source` both need to answer "does a
 * declared entity in this project's source name this live object" — which
 * needs the project built (chant.config.ts read, source discovered and
 * resolved). `chant kube` is also usable against a bare cluster with no
 * chant project in sight (a checkout of someone else's manifests, a
 * throwaway directory) — the acceptance criterion is that reads still work
 * there and only the chant-specific parts degrade, quietly, to
 * "unavailable" rather than erroring. Every failure mode here — no
 * `chant.config.ts`, a project with build errors, an unreadable directory —
 * collapses to `undefined` for exactly that reason.
 *
 * Deliberately does not import anything client-shaped: this runs before a
 * cluster is ever reached (`source`/`get` need it to compute a verdict for
 * objects the client already read), and matching is pure once given a live
 * object's coordinates.
 */

import { resolve, relative, isAbsolute } from "node:path";
import { build } from "@intentius/chant/build";
import { loadChantConfig, type ChantConfig } from "@intentius/chant/config";
import { getProvenance, type EntityProvenance } from "@intentius/chant/provenance";
import type { Declarable } from "@intentius/chant/declarable";
import { k8sSerializer } from "../serializer";
import { operationFor } from "../api/operation-surface";

export interface KubeProjectContext {
  cwd: string;
  config: ChantConfig;
  entities: Map<string, Declarable>;
}

/**
 * Build the project rooted at `cwd` (or its configured `sourceDir`) with the
 * k8s serializer, so `entities` carries resolved props (composites expanded,
 * AttrRefs resolved) and build provenance (chant #1064's entity-level
 * `sourceFile`/`composite`, stamped during discovery). Returns undefined —
 * never throws — for anything that stops the project from resolving: no
 * `chant.config.ts` here or above, a build with errors, an inaccessible
 * directory. This IS the "outside a chant project" signal every caller
 * checks for.
 */
export async function loadKubeProjectContext(cwd: string = process.cwd()): Promise<KubeProjectContext | undefined> {
  try {
    const { config, configPath } = await loadChantConfig(cwd);
    // `loadChantConfig` does not throw when neither `chant.config.ts` nor
    // `chant.config.json` exists at `cwd` — it returns the default empty
    // config instead (`configPath` absent). Building anyway would treat an
    // arbitrary directory (a bare cluster checkout, chant's own monorepo
    // root run from the wrong cwd) as a chant project rooted right there —
    // exactly the "outside a chant project" case this function exists to
    // detect, not paper over.
    if (!configPath) return undefined;
    const root = resolve(cwd, config.sourceDir ?? ".");
    const result = await build(root, [k8sSerializer]);
    if (result.errors.length > 0) return undefined;
    return { cwd, config, entities: result.entities };
  } catch {
    return undefined;
  }
}

function propsOf(entity: Declarable): Record<string, unknown> | undefined {
  return "props" in entity ? ((entity as { props: unknown }).props as Record<string, unknown>) : undefined;
}

export interface DeclaredMatch {
  entityName: string;
  entity: Declarable;
  props: Record<string, unknown> | undefined;
}

/**
 * Reverse-map a live object's coordinates (apiVersion/kind/name/namespace) to
 * the declared k8s entity that names it, if this project declares one.
 * `operationFor` is the same generated operation surface `describeResources`
 * addresses entities with, so a match here is addressed exactly the way the
 * live read that produced the object was — no separate naming convention.
 */
export function findDeclaredMatch(
  entities: Map<string, Declarable>,
  ref: { apiVersion: string; kind: string; name: string; namespace?: string },
): DeclaredMatch | undefined {
  for (const [entityName, entity] of entities) {
    if (entity.lexicon !== "k8s") continue;
    const operation = operationFor(entity.entityType);
    if (!operation || operation.apiVersion !== ref.apiVersion || operation.kind !== ref.kind) continue;
    const props = propsOf(entity);
    const metadata = props?.metadata as { name?: string; namespace?: string } | undefined;
    if (metadata?.name !== ref.name) continue;
    if ((metadata?.namespace ?? undefined) !== (ref.namespace ?? undefined)) continue;
    return { entityName, entity, props };
  }
  return undefined;
}

/** Provenance for a matched entity, relative to the project root when possible. */
export function relativeProvenance(ctx: KubeProjectContext, entity: Declarable): EntityProvenance | undefined {
  const prov = getProvenance(entity);
  if (!prov) return undefined;
  if (!prov.sourceFile || !isAbsolute(prov.sourceFile)) return prov;
  const rel = relative(ctx.cwd, prov.sourceFile);
  return { ...prov, sourceFile: rel.startsWith("..") ? prov.sourceFile : rel };
}
