/**
 * A complete Kubernetes manifest carried into a build as a chant entity.
 *
 * Two callers produce one: a kustomize build root, whose output is a set of
 * finished documents rather than typed chant source (#1548), and `chant carve
 * emit` adopting a Terraform `kubernetes_manifest` (#999), whose whole content
 * is a manifest body read out of state. In both cases the document already
 * decided every field, so `props` IS the manifest: the serializer emits it
 * as-is — plus the default-label / ownership merge every discovered resource
 * gets — instead of running the spec-inference heuristics built for typed
 * declarables, which would re-nest a top-level field that is not `spec`
 * (`rules` on a ClusterRole, `webhooks` on a webhook config).
 *
 * The marker is what tells the serializer to take that path — `Symbol.for`, so
 * a lexicon built against a separate copy of core still matches (the #1137
 * lesson).
 *
 * `entityType` comes from `gvkToTypeName`, the one group→namespace rule
 * (`./group-namespace`), so a manifest declared this way is typed exactly as a
 * generated class would be and `lifecycle diff --live` observes it through the
 * reader a declared resource uses. A kind the generated operation surface does
 * not know reports NOT-OBSERVED with the existing "no generated operation
 * surface" reason — the honest verdict, not a silent hole.
 */
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { gvkToTypeName } from "./spec/parse";

/** Marks an entity whose `props` are a complete, render-final manifest. */
export const RENDERED_MANIFEST_MARKER = Symbol.for("chant.k8s.renderedManifest");

export interface RenderedManifestEntity extends Declarable {
  readonly kind: "resource";
  readonly props: Record<string, unknown>;
  readonly [RENDERED_MANIFEST_MARKER]: true;
}

export function isRenderedManifestEntity(entity: Declarable): entity is RenderedManifestEntity {
  return (entity as unknown as Record<symbol, unknown>)[RENDERED_MANIFEST_MARKER] === true;
}

/**
 * Wrap one manifest. Returns null when the document has no string
 * `apiVersion`/`kind` — not a Kubernetes object, nothing to declare.
 */
export function manifestEntity(doc: Record<string, unknown>): RenderedManifestEntity | null {
  const apiVersion = doc.apiVersion;
  const kind = doc.kind;
  if (typeof apiVersion !== "string" || typeof kind !== "string" || !apiVersion || !kind) return null;

  const slash = apiVersion.indexOf("/");
  const group = slash === -1 ? "" : apiVersion.slice(0, slash);
  const version = slash === -1 ? apiVersion : apiVersion.slice(slash + 1);

  return {
    lexicon: "k8s",
    entityType: gvkToTypeName({ group, version, kind }),
    kind: "resource",
    props: { ...doc },
    [DECLARABLE_MARKER]: true,
    [RENDERED_MANIFEST_MARKER]: true,
  };
}

/**
 * Declare an arbitrary Kubernetes object from its manifest — the escape hatch
 * for a kind the lexicon ships no generated class for, and what `chant carve
 * emit` writes when it adopts a `kubernetes_manifest` (#999). The typed
 * constructors cannot serve either case: their props are the kind's own schema,
 * so an unknown CRD has no class at all and a known one rejects an
 * `apiVersion`/`kind` pair that differs from the generated default.
 *
 * Throws on a document without a string `apiVersion` and `kind`: those two
 * fields are what makes it addressable, and a silently dropped resource is the
 * failure this is guarding against.
 */
export function k8sManifest(doc: Record<string, unknown>): RenderedManifestEntity {
  const entity = manifestEntity(doc);
  if (!entity) {
    throw new Error("k8sManifest requires a document with string `apiVersion` and `kind` fields.");
  }
  return entity;
}
