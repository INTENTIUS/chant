/**
 * Kinds a project generated for itself with `chant generate` from `k8s.crds`
 * (./crd/project-codegen.ts), as opposed to the kinds the lexicon ships in
 * `generated/lexicon-k8s.json`.
 *
 * The serializer's GVK lookup and the CRD spec checks (WK8501/WK8502) consult
 * this registry before the packaged JSON. Entries arrive two ways:
 *
 * - The generated module registers its kinds (type and GVK) when it is
 *   imported, so a project's own tests that construct and serialize a
 *   resource need nothing else.
 * - A build registers every kind, spec schema included, from the committed
 *   `kinds.json` beside the module before it serializes (the plugin's
 *   `projectCodegen().load`). That covers a build whose discovery imported the
 *   module somewhere else, such as the sandboxed child process.
 *
 * The store hangs off `globalThis` under a registered symbol, so two copies
 * of this module (the plugin the CLI loaded and the one a project's import
 * resolved) share it. No Node imports: the post-synth barrel reaches this
 * through ./lint/post-synth/crd-schema-helpers.ts and must stay edge-safe.
 */

import type { CrdFieldSchema } from "./spec/parse";

/** One project-generated kind. */
export interface ProjectKind {
  /** The entity type the generated class constructs, e.g. `K8s::Example::Widget`. */
  resourceType: string;
  /** e.g. `example.com/v1`. */
  apiVersion: string;
  /** e.g. `Widget`. */
  kind: string;
  /** The CRD's `spec` field schema, for the spec checks. */
  specSchema?: CrdFieldSchema;
}

const STORE = Symbol.for("@intentius/chant-lexicon-k8s/project-kinds");

function store(): Map<string, ProjectKind> {
  const g = globalThis as { [STORE]?: Map<string, ProjectKind> };
  g[STORE] ??= new Map();
  return g[STORE];
}

/**
 * Register project-generated kinds. A later registration of the same type
 * replaces the earlier one, keeping its spec schema when the new entry has
 * none (the module's import-time registration carries no schema).
 */
export function registerProjectKinds(kinds: readonly ProjectKind[]): void {
  const s = store();
  for (const k of kinds) {
    const previous = s.get(k.resourceType);
    const specSchema = k.specSchema ?? (previous?.apiVersion === k.apiVersion && previous.kind === k.kind ? previous.specSchema : undefined);
    s.set(k.resourceType, { ...k, ...(specSchema ? { specSchema } : {}) });
  }
}

/** The project kind an entity type constructs, if a project registered one. */
export function projectKindForType(resourceType: string): ProjectKind | undefined {
  return store().get(resourceType);
}

/** The spec schema a project registered for `apiVersion`/`kind`, if any. */
export function projectSpecSchema(apiVersion: string, kind: string): CrdFieldSchema | undefined {
  for (const k of store().values()) {
    if (k.apiVersion === apiVersion && k.kind === kind && k.specSchema) return k.specSchema;
  }
  return undefined;
}

/** Test seam: forget every registered kind. */
export function clearProjectKinds(): void {
  store().clear();
}
