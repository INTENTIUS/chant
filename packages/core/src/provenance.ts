/**
 * Build provenance: where a declared entity came from in the TypeScript source.
 *
 * Stamped during discovery as a non-enumerable, symbol-keyed side channel on the
 * entity object, so it never serializes into the emitted YAML/JSON — it is build
 * metadata, not declared configuration. Read it back with {@link getProvenance}.
 *
 * This is entity-level provenance (which file declared it, and which composite
 * expanded it), not a YAML-line source map. It answers "where did this resource
 * come from?", which is the question an agent asks before changing it.
 */

const PROVENANCE = Symbol.for("chant.provenance");

export interface EntityProvenance {
  /** Absolute path of the source file that declared (or exported) the entity. */
  sourceFile?: string;
  /** The composite (type) that expanded this entity, when it came from one. */
  composite?: string;
  /**
   * The composite *instance* this entity belongs to — the export name of the
   * top-level composite, shared by every member it expanded to. Distinguishes
   * two instances of the same composite type, which `composite` cannot. Used to
   * collapse a composite to a single node at coarse diagram detail levels (#494).
   */
  compositeInstance?: string;
}

/**
 * Merge provenance onto an entity. Non-enumerable so it is invisible to
 * serializers and spreads. Existing fields win (`??=`), so the first/most
 * specific writer — the innermost composite, the declaring file — is kept.
 */
export function setProvenance(entity: object, prov: EntityProvenance): void {
  if (!Object.isExtensible(entity)) return;
  const existing = (entity as Record<symbol, unknown>)[PROVENANCE] as EntityProvenance | undefined;
  if (existing) {
    existing.sourceFile ??= prov.sourceFile;
    existing.composite ??= prov.composite;
    existing.compositeInstance ??= prov.compositeInstance;
    return;
  }
  Object.defineProperty(entity, PROVENANCE, {
    value: { ...prov },
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/** Read an entity's build provenance, if any was stamped. */
export function getProvenance(entity: object): EntityProvenance | undefined {
  return (entity as Record<symbol, unknown>)[PROVENANCE] as EntityProvenance | undefined;
}
