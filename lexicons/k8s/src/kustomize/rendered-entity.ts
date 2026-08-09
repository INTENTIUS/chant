/**
 * A rendered kustomize document as a chant entity (#1548 piece 3).
 *
 * A kustomize build root's output is a set of finished manifests, not typed
 * chant source — the overlay already decided every field. So the entity that
 * carries one into the build is deliberately verbatim: `props` IS the
 * document, and the serializer emits it as-is (plus the same default-label /
 * ownership merge every discovered resource gets) instead of running the
 * spec-inference heuristics built for typed declarables. The marker is what
 * tells the serializer to take that path — `Symbol.for`, so a lexicon built
 * against a separate copy of core still matches (the #1137 lesson).
 *
 * `entityType` uses the same `K8s::{Group}::{Kind}` convention the generated
 * operation surface speaks, so `lifecycle diff --live` observes a rendered
 * Deployment through exactly the reader a declared one uses. A kind the
 * surface doesn't know reports NOT-OBSERVED with the existing "no generated
 * operation surface" reason — the honest verdict, not a silent hole.
 *
 * Provenance: every rendered document is stamped with an annotation naming
 * the overlay dir it came from, so a consumer (behold#171's overlay boxes)
 * can group by declared origin instead of guessing from paths.
 */
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { gvkToTypeName } from "../spec/parse";

/** Marks an entity whose `props` are a complete, render-final manifest. */
export const RENDERED_MANIFEST_MARKER = Symbol.for("chant.k8s.renderedManifest");

/** Annotation stamped on every rendered document, valued with the root dir. */
export const KUSTOMIZE_ROOT_ANNOTATION = "chant.intentius.io/kustomize-root";

export interface RenderedManifestEntity extends Declarable {
  readonly kind: "resource";
  readonly props: Record<string, unknown>;
  readonly [RENDERED_MANIFEST_MARKER]: true;
}

export function isRenderedManifestEntity(entity: Declarable): entity is RenderedManifestEntity {
  return (entity as unknown as Record<symbol, unknown>)[RENDERED_MANIFEST_MARKER] === true;
}

/**
 * Wrap one rendered document. Returns null when the document has no string
 * `apiVersion`/`kind` — not a Kubernetes object, nothing to declare.
 */
export function renderedManifestEntity(
  doc: Record<string, unknown>,
  root: string,
): RenderedManifestEntity | null {
  const apiVersion = doc.apiVersion;
  const kind = doc.kind;
  if (typeof apiVersion !== "string" || typeof kind !== "string" || !apiVersion || !kind) return null;

  const slash = apiVersion.indexOf("/");
  const group = slash === -1 ? "" : apiVersion.slice(0, slash);
  const version = slash === -1 ? apiVersion : apiVersion.slice(slash + 1);

  const metadata = { ...((doc.metadata as Record<string, unknown> | undefined) ?? {}) };
  metadata.annotations = {
    ...((metadata.annotations as Record<string, unknown> | undefined) ?? {}),
    [KUSTOMIZE_ROOT_ANNOTATION]: root,
  };

  return {
    lexicon: "k8s",
    entityType: gvkToTypeName({ group, version, kind }),
    kind: "resource",
    props: { ...doc, metadata },
    [DECLARABLE_MARKER]: true,
    [RENDERED_MANIFEST_MARKER]: true,
  };
}
