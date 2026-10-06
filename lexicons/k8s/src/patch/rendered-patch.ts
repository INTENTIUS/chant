/**
 * Patching rendered documents (#3566 item 3).
 *
 * A Helm render, a kustomize build root and a `k8sInclude` all hand chant
 * finished manifests. When a chart or an upstream bundle does not expose a
 * field, the alternatives were forking it or running an overlay outside
 * chant. A `RenderedPatch` selects documents by kind and name (namespace and
 * apiVersion optional) and changes them before they become entities, so the
 * patched form is what the serializer emits, what ownership stamping and
 * post-synth checks see, and what `lifecycle diff --live` compares against
 * the cluster.
 *
 * One patch type for all three sources: `HelmRender({ patches })`,
 * `k8sInclude({ patches })`, and `{ path, patches }` entries in
 * `k8s.kustomize.roots`. Each source calls {@link applyRenderedPatches} on
 * its parsed documents.
 *
 * A selector that matches nothing is an error. The common way to get there
 * is a chart upgrade that renamed a resource, and a patch that silently
 * stops applying is the failure this guards against. There is no opt-out:
 * a patch whose target is legitimately absent (a chart value that turns a
 * resource off) belongs behind the same condition in TypeScript that sets
 * the value.
 */
import type * as Generated from "../generated/index";
import { applyJsonPatch, applyMergePatch, type JsonPatchOperation } from "./json-patch";

export type { JsonPatchOperation } from "./json-patch";
export { applyJsonPatch, applyMergePatch } from "./json-patch";

/** Which rendered documents a patch applies to. */
export interface RenderedSelector<K extends string = string> {
  /** The document's `kind`, e.g. `"Deployment"`. */
  kind: K;
  /** The document's `metadata.name`. */
  name: string;
  /** The document's `metadata.namespace`. Omitted, documents in any namespace (or none) match. */
  namespace?: string;
  /** The document's `apiVersion`, for a kind name two API groups share. */
  apiVersion?: string;
}

/**
 * The props the lexicon's class for `K` takes, when there is one; otherwise
 * an open record. Merge patches for known kinds are checked against it.
 */
export type KindProps<K extends string> = K extends keyof typeof Generated
  ? (typeof Generated)[K] extends new (props: infer P, ...rest: never[]) => unknown
    ? P
    : Record<string, unknown>
  : Record<string, unknown>;

/** An RFC 7386 merge patch over `T`: every field optional, `null` deletes. */
export type MergePatchOf<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [P in keyof T]?: MergePatchOf<T[P]> | null }
    : T;

/** A patch applied as RFC 6902 operations. */
export interface RenderedJsonPatch<K extends string = string> extends RenderedSelector<K> {
  jsonPatch: JsonPatchOperation[];
  merge?: never;
}

/** A patch applied as an RFC 7386 merge. */
export interface RenderedMergePatch<K extends string = string> extends RenderedSelector<K> {
  merge: MergePatchOf<KindProps<K>>;
  jsonPatch?: never;
}

/** One patch on rendered output: a selector plus either `jsonPatch` or `merge`. */
export type RenderedPatch<K extends string = string> = RenderedJsonPatch<K> | RenderedMergePatch<K>;

/**
 * Identity helper that infers `kind`, so a `merge` body is checked against
 * that kind's props:
 *
 * ```ts
 * renderedPatch({ kind: "Deployment", name: "web", merge: { spec: { replicas: 3 } } })
 * ```
 *
 * A plain object literal works anywhere a `RenderedPatch` is taken; it just
 * types `merge` as an open record.
 */
export function renderedPatch<K extends string>(patch: RenderedPatch<K>): RenderedPatch {
  return patch as unknown as RenderedPatch;
}

function describeSelector(sel: RenderedSelector): string {
  const parts = [`kind ${sel.kind}`, `name ${sel.name}`];
  if (sel.namespace !== undefined) parts.push(`namespace ${sel.namespace}`);
  if (sel.apiVersion !== undefined) parts.push(`apiVersion ${sel.apiVersion}`);
  return parts.join(", ");
}

function metadataOf(doc: Record<string, unknown>): Record<string, unknown> {
  const m = doc.metadata;
  return typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function matches(doc: Record<string, unknown>, sel: RenderedSelector): boolean {
  if (doc.kind !== sel.kind) return false;
  if (sel.apiVersion !== undefined && doc.apiVersion !== sel.apiVersion) return false;
  const metadata = metadataOf(doc);
  if (metadata.name !== sel.name) return false;
  if (sel.namespace !== undefined && metadata.namespace !== sel.namespace) return false;
  return true;
}

/**
 * Apply `patches` in order to `docs` and return the patched documents, in
 * the same order. `source` names where the documents came from (a chart, a
 * file, a URL, an overlay dir) and leads every error message.
 *
 * Each patch applies to every document its selector matches at that point,
 * so a later patch sees an earlier one's changes. Throws when a selector
 * matches nothing, when an operation fails (a `test` included), when a patch
 * carries both or neither of `jsonPatch` and `merge`, and when a patched
 * document no longer has a string `apiVersion` and `kind`.
 */
export function applyRenderedPatches(
  docs: ReadonlyArray<Record<string, unknown>>,
  patches: ReadonlyArray<RenderedPatch> | undefined,
  source: string,
): Array<Record<string, unknown>> {
  const out = [...docs];
  if (!patches || patches.length === 0) return out;

  patches.forEach((patch, p) => {
    const where = `${source}: patch ${p} (${describeSelector(patch)})`;
    const hasJson = patch.jsonPatch !== undefined;
    const hasMerge = patch.merge !== undefined;
    if (hasJson === hasMerge) {
      throw new Error(`${where} must set exactly one of jsonPatch and merge`);
    }

    let matched = 0;
    for (let i = 0; i < out.length; i++) {
      if (!matches(out[i], patch)) continue;
      matched++;
      let next: Record<string, unknown>;
      try {
        next = hasJson ? applyJsonPatch(out[i], patch.jsonPatch!) : applyMergePatch(out[i], patch.merge);
      } catch (err) {
        throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (typeof next !== "object" || next === null || typeof next.apiVersion !== "string" || typeof next.kind !== "string") {
        throw new Error(`${where} left a document without a string apiVersion and kind`);
      }
      out[i] = next;
    }

    if (matched === 0) {
      const sameKind = out
        .filter((d) => d.kind === patch.kind)
        .map((d) => {
          const m = metadataOf(d);
          return typeof m.namespace === "string" ? `${m.namespace}/${String(m.name)}` : String(m.name);
        });
      throw new Error(
        `${where} matched no document. ` +
          (sameKind.length > 0
            ? `${patch.kind} documents present: ${sameKind.join(", ")}.`
            : `There are no ${patch.kind} documents.`),
      );
    }
  });

  return out;
}
