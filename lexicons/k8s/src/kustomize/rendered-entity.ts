/**
 * A rendered kustomize document as a chant entity (#1548 piece 3).
 *
 * A kustomize build root's output is a set of finished manifests, not typed
 * chant source — the overlay already decided every field. The entity that
 * carries one into the build is therefore the verbatim manifest entity
 * (`../manifest-entity`), shared since #999 with `chant carve emit`'s adoption
 * of a Terraform `kubernetes_manifest`: `props` IS the document, and the
 * serializer emits it as-is.
 *
 * Provenance: every rendered document is stamped with an annotation naming
 * the overlay dir it came from, so a consumer (behold#171's overlay boxes)
 * can group by declared origin instead of guessing from paths — the one thing
 * this adds over a plain manifest entity.
 */
import { manifestEntity, RENDERED_MANIFEST_MARKER, isRenderedManifestEntity } from "../manifest-entity";
import type { RenderedManifestEntity } from "../manifest-entity";
import type { Declarable } from "@intentius/chant/declarable";

export { RENDERED_MANIFEST_MARKER, isRenderedManifestEntity };
export type { RenderedManifestEntity };

/** Annotation stamped on every rendered document, valued with the root dir. */
export const KUSTOMIZE_ROOT_ANNOTATION = "chant.intentius.io/kustomize-root";

/**
 * Wrap one rendered document. Returns null when the document has no string
 * `apiVersion`/`kind` — not a Kubernetes object, nothing to declare.
 *
 * `annotation` is the provenance key: the kustomize root annotation by
 * default, `k8sInclude`'s source annotation for an included file (#3566).
 */
export function renderedManifestEntity(
  doc: Record<string, unknown>,
  root: string,
  annotation: string = KUSTOMIZE_ROOT_ANNOTATION,
): RenderedManifestEntity | null {
  const metadata = { ...((doc.metadata as Record<string, unknown> | undefined) ?? {}) };
  metadata.annotations = {
    ...((metadata.annotations as Record<string, unknown> | undefined) ?? {}),
    [annotation]: root,
  };

  return manifestEntity({ ...doc, metadata });
}

/** `Deployment` + `my-app` → `deploymentMyApp`, the import path's naming. */
export function renderedLogicalId(kind: string, name: string | undefined): string {
  const prefix = kind.charAt(0).toLowerCase() + kind.slice(1);
  if (!name) return prefix;
  const pascal = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${prefix}${pascal}`;
}

/**
 * Add a rendered entity under a deterministic, human-readable key:
 * `<prefix>/<kindName>`. Two documents can share kind+name (different
 * namespaces, or different API groups with the same kind word), so a
 * collision is qualified by namespace first, then numbered in document
 * order. Returns the key used.
 */
export function addRenderedEntity(
  entities: Map<string, Declarable>,
  prefix: string,
  entity: RenderedManifestEntity,
): string {
  const metadata = entity.props.metadata as Record<string, unknown>;
  const kind = entity.props.kind as string;
  const name = typeof metadata.name === "string" ? metadata.name : undefined;
  const namespace = typeof metadata.namespace === "string" ? metadata.namespace : undefined;

  const base = `${prefix}/${renderedLogicalId(kind, name)}`;
  let key = base;
  if (entities.has(key) && namespace) key = `${base}.${namespace}`;
  for (let n = 2; entities.has(key); n++) key = `${base}~${n}`;
  entities.set(key, entity);
  return key;
}
