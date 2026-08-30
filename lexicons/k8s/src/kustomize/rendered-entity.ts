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

export { RENDERED_MANIFEST_MARKER, isRenderedManifestEntity };
export type { RenderedManifestEntity };

/** Annotation stamped on every rendered document, valued with the root dir. */
export const KUSTOMIZE_ROOT_ANNOTATION = "chant.intentius.io/kustomize-root";

/**
 * Wrap one rendered document. Returns null when the document has no string
 * `apiVersion`/`kind` — not a Kubernetes object, nothing to declare.
 */
export function renderedManifestEntity(
  doc: Record<string, unknown>,
  root: string,
): RenderedManifestEntity | null {
  const metadata = { ...((doc.metadata as Record<string, unknown> | undefined) ?? {}) };
  metadata.annotations = {
    ...((metadata.annotations as Record<string, unknown> | undefined) ?? {}),
    [KUSTOMIZE_ROOT_ANNOTATION]: root,
  };

  return manifestEntity({ ...doc, metadata });
}
